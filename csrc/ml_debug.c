#include "ml_debug.h"
#include "minilang.h"
#include "ml_macros.h"
#include "ml_compiler.h"
#include "ml_bytecode.h"
#include "ml_runtime.h"
#include "stringmap.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern stringmap_t MLGlobals[1];
extern void mlk_init(const char *exec_name);
extern void mlk_set_output_cbs(mld_stdout_cb stdout_cb, mld_display_cb display_cb, void *ctx);

/* Per-source breakpoint bitmask table (GC-allocated so Minilang bytecode can hold raw pointers safely) */
typedef struct {
    size_t Count;
    size_t Bits[];
} dbg_bp_table_t;

static stringmap_t g_bp_map[1] = {STRINGMAP_INIT};
static char g_ws_root[4096] = {0};
static size_t g_ws_root_len = 0;

static ml_debugger_t g_debugger;
static ml_context_t *g_dbg_ctx = NULL;

static ml_state_t *g_paused_state = NULL;
static ml_value_t *g_paused_value = NULL;
static int g_is_paused = 0;
static int g_done = 0;
static ml_value_t *g_final_value = NULL;

static char g_pause_reason[32] = {0};
static int g_in_break_fn = 0;
static int g_expect_step = 0;
static int g_on_entry_first = 0;

typedef struct {
    ml_state_t Base;
    ml_value_t *Value;
    int Done;
} dbg_sync_state_t;

static void dbg_sync_state_run(dbg_sync_state_t *State, ml_value_t *Value) {
    State->Value = Value;
    State->Done = 1;
}

static void dbg_done_state_run(ml_state_t *State, ml_value_t *Value) {
    (void)State;
    g_final_value = Value;
    g_done = 1;
}

static ml_state_t g_done_state;

/* Normalize a source path: if it is inside g_ws_root, strip the workspace prefix */
static const char *dbg_normalize_source(const char *src, char *buf, size_t cap) {
    if (!src || !*src) {
        snprintf(buf, cap, "<unknown>");
        return buf;
    }
    if (g_ws_root_len > 0 && strncmp(src, g_ws_root, g_ws_root_len) == 0) {
        if (src[g_ws_root_len] == '/') {
            const char *rel = src + g_ws_root_len + 1;
            snprintf(buf, cap, "%s", rel);
            return buf;
        }
    }
    /* Strip leading "./" if present */
    if (src[0] == '.' && src[1] == '/') {
        snprintf(buf, cap, "%s", src + 2);
        return buf;
    }
    snprintf(buf, cap, "%s", src);
    return buf;
}

static dbg_bp_table_t *dbg_ensure_bp_table(const char *norm_source, int min_line) {
    if (!norm_source) norm_source = "<unknown>";
    size_t need_words = (size_t)((min_line > 0 ? min_line : 64) / (int)SIZE_BITS) + 2;
    if (need_words < 4) need_words = 4;

    dbg_bp_table_t **slot = (dbg_bp_table_t **)stringmap_slot(g_bp_map, norm_source);
    if (!slot[0]) {
        /* Copy key into GC memory so stringmap key never dangles */
        size_t slen = strlen(norm_source);
        char *key_copy = snew(slen + 1);
        memcpy(key_copy, norm_source, slen + 1);
        stringmap_remove(g_bp_map, norm_source);
        slot = (dbg_bp_table_t **)stringmap_slot(g_bp_map, key_copy);

        dbg_bp_table_t *tbl = (dbg_bp_table_t *)xnew(dbg_bp_table_t, need_words, size_t);
        tbl->Count = need_words;
        memset(tbl->Bits, 0, need_words * sizeof(size_t));
        slot[0] = tbl;
    } else if (slot[0]->Count < need_words) {
        dbg_bp_table_t *old = slot[0];
        dbg_bp_table_t *tbl = (dbg_bp_table_t *)xnew(dbg_bp_table_t, need_words, size_t);
        tbl->Count = need_words;
        memset(tbl->Bits, 0, need_words * sizeof(size_t));
        memcpy(tbl->Bits, old->Bits, old->Count * sizeof(size_t));
        slot[0] = tbl;
    }
    return slot[0];
}

static int dbg_has_bp(const char *source, int line) {
    if (!source || line <= 0) return 0;
    char norm[4096];
    dbg_normalize_source(source, norm, sizeof(norm));
    dbg_bp_table_t *tbl = (dbg_bp_table_t *)stringmap_search(g_bp_map, norm);
    if (!tbl) return 0;
    size_t word = (size_t)line / SIZE_BITS;
    if (word >= tbl->Count) return 0;
    return (tbl->Bits[word] & ((size_t)1 << ((size_t)line % SIZE_BITS))) != 0;
}

static size_t *dbg_get_breakpoints(ml_debugger_t *Debugger, const char *Source, int LineNo) {
    (void)Debugger;
    char norm[4096];
    dbg_normalize_source(Source, norm, sizeof(norm));
    dbg_bp_table_t *tbl = dbg_ensure_bp_table(norm, LineNo > 0 ? LineNo : 256);
    return tbl->Bits;
}

static void dbg_on_pause(ml_debugger_t *Debugger, ml_state_t *Frame, ml_value_t *Value) {
    (void)Debugger;
    int from_break = g_in_break_fn;
    g_in_break_fn = 0;

    ml_source_t src = ml_debugger_source(Frame);
    int is_err = (Value && ml_is_error(Value));

    /*
     * Work around ml_closure_call_debug's entry breakpoint quirk:
     * At closure entry, Minilang sets Frame->Line = Info->Entry->Line - 1 and calls
     * Debugger->run() if Info->Entry->Line has a breakpoint, WITHOUT setting Frame->Reentry = 1.
     * Immediately continuing into frame_run advances 0 instructions and hits DO_BREAKPOINT
     * on the exact Info->Entry->Line with Frame->Line properly updated and Frame->Reentry = 1.
     */
    if (!from_break && !is_err) {
        if (src.Line == 0) {
            Frame->run(Frame, Value);
            return;
        }
        if (!g_expect_step && !dbg_has_bp(src.Name, src.Line) && dbg_has_bp(src.Name, src.Line + 1)) {
            Frame->run(Frame, Value);
            return;
        }
    }

    if (is_err) {
        snprintf(g_pause_reason, sizeof(g_pause_reason), "error");
    } else if (from_break) {
        snprintf(g_pause_reason, sizeof(g_pause_reason), "break");
    } else if (g_on_entry_first) {
        g_on_entry_first = 0;
        snprintf(g_pause_reason, sizeof(g_pause_reason), "entry");
    } else if (dbg_has_bp(src.Name, src.Line)) {
        snprintf(g_pause_reason, sizeof(g_pause_reason), "breakpoint");
    } else {
        snprintf(g_pause_reason, sizeof(g_pause_reason), "step");
    }

    g_expect_step = 0;
    g_paused_state = Frame;
    g_paused_value = Value;
    g_is_paused = 1;
}

ML_FUNCTIONX(MLDbgBreak) {
    ml_debugger_t *Debugger = (ml_debugger_t *)ml_context_get_static(Caller->Context, ML_DEBUGGER_INDEX);
    if (!Debugger) ML_RETURN(MLNil);
    if (Count && Args[0] == MLNil) ML_RETURN(MLNil);
    g_in_break_fn = 1;
    return Debugger->run(Debugger, Caller, MLNil);
}

void ml_dbg_init(const char *exec_name, const char *ws_root) {
    mlk_init(exec_name);
    stringmap_insert(MLGlobals, "break", MLDbgBreak);

    if (ws_root && *ws_root) {
        char canon[4096];
        if (realpath(ws_root, canon)) {
            snprintf(g_ws_root, sizeof(g_ws_root), "%s", canon);
        } else {
            snprintf(g_ws_root, sizeof(g_ws_root), "%s", ws_root);
        }
        g_ws_root_len = strlen(g_ws_root);
        while (g_ws_root_len > 1 && g_ws_root[g_ws_root_len - 1] == '/') {
            g_ws_root[--g_ws_root_len] = '\0';
        }
    }

    memset(&g_debugger, 0, sizeof(g_debugger));
    g_debugger.Revision = 1;
    g_debugger.run = dbg_on_pause;
    g_debugger.breakpoints = dbg_get_breakpoints;
    g_debugger.StepIn = 0;
    g_debugger.BreakOnError = 0;

    g_dbg_ctx = ml_context(MLRootContext);
    ml_context_set_static(g_dbg_ctx, ML_DEBUGGER_INDEX, &g_debugger);
}

void ml_dbg_set_breakpoints(const char *source, const int *lines, size_t count) {
    char norm[4096];
    dbg_normalize_source(source, norm, sizeof(norm));

    int max_line = 256;
    for (size_t i = 0; i < count; ++i) {
        if (lines[i] > max_line) max_line = lines[i];
    }

    dbg_bp_table_t *tbl = dbg_ensure_bp_table(norm, max_line);
    memset(tbl->Bits, 0, tbl->Count * sizeof(size_t));
    for (size_t i = 0; i < count; ++i) {
        int ln = lines[i];
        if (ln > 0) {
            size_t word = (size_t)ln / SIZE_BITS;
            if (word < tbl->Count) {
                tbl->Bits[word] |= ((size_t)1 << ((size_t)ln % SIZE_BITS));
            }
        }
    }
    g_debugger.Revision++;
}

static int dbg_clear_bp_iter(const char *Key, void *Val, void *Data) {
    (void)Key;
    (void)Data;
    dbg_bp_table_t *tbl = (dbg_bp_table_t *)Val;
    if (tbl) {
        memset(tbl->Bits, 0, tbl->Count * sizeof(size_t));
    }
    return 0;
}

void ml_dbg_clear_all_breakpoints(void) {
    stringmap_foreach(g_bp_map, NULL, dbg_clear_bp_iter);
    g_debugger.Revision++;
}

void ml_dbg_set_break_on_error(int enabled) {
    g_debugger.BreakOnError = enabled ? 1 : 0;
}

static int dbg_current_status(void) {
    if (g_is_paused) return ML_DBG_STATUS_PAUSED;
    if (g_done) {
        if (g_final_value && ml_is_error(ml_deref(g_final_value))) {
            return ML_DBG_STATUS_ERROR;
        }
        return ML_DBG_STATUS_COMPLETED;
    }
    return ML_DBG_STATUS_IDLE;
}

int ml_dbg_start(
    const char *source_name,
    const char *code,
    int stop_on_entry,
    int break_on_error,
    mld_stdout_cb stdout_cb,
    mld_display_cb display_cb,
    void *cb_ctx
) {
    g_paused_state = NULL;
    g_paused_value = NULL;
    g_is_paused = 0;
    g_done = 0;
    g_final_value = NULL;
    g_pause_reason[0] = '\0';
    g_in_break_fn = 0;
    g_expect_step = stop_on_entry ? 1 : 0;
    g_on_entry_first = stop_on_entry ? 1 : 0;

    g_debugger.StepIn = stop_on_entry ? 1 : 0;
    g_debugger.BreakOnError = break_on_error ? 1 : 0;
    g_debugger.Revision++;

    mlk_set_output_cbs(stdout_cb, display_cb, cb_ctx);

    size_t len = code ? strlen(code) : 0;
    char *buf = snew(len + 2);
    if (len > 0) memcpy(buf, code, len);
    if (len == 0 || buf[len - 1] != '\n') {
        buf[len] = '\n';
        buf[len + 1] = '\0';
    } else {
        buf[len] = '\0';
    }

    char norm[4096];
    dbg_normalize_source(source_name ? source_name : "<debug>", norm, sizeof(norm));
    size_t slen = strlen(norm);
    char *src_copy = snew(slen + 1);
    memcpy(src_copy, norm, slen + 1);

    ml_parser_t *parser = ml_parser(NULL, NULL);
    ml_parser_source(parser, (ml_source_t){src_copy, 1, 0});
    ml_parser_input(parser, buf, 0);

    const mlc_expr_t *expr = ml_accept_file(parser);
    if (!expr) {
        g_final_value = ml_parser_value(parser);
        if (!g_final_value || !ml_is_error(g_final_value)) {
            g_final_value = ml_error("ParseError", "Failed to parse Minilang source");
        }
        g_done = 1;
        mlk_set_output_cbs(NULL, NULL, NULL);
        return ML_DBG_STATUS_ERROR;
    }

    ml_compiler_t *compiler = ml_compiler2((ml_getter_t)ml_stringmap_global_get, MLGlobals, 0);
    dbg_sync_state_t compile_state[1];
    memset(compile_state, 0, sizeof(compile_state));
    compile_state->Base.Type = MLStateT;
    compile_state->Base.Caller = NULL;
    compile_state->Base.Context = MLRootContext;
    compile_state->Base.run = (ml_state_fn)dbg_sync_state_run;

    ml_function_compile((ml_state_t *)compile_state, expr, compiler, NULL);

    if (!compile_state->Done || !compile_state->Value) {
        g_final_value = ml_error("CompileError", "Failed to compile Minilang source");
        g_done = 1;
        mlk_set_output_cbs(NULL, NULL, NULL);
        return ML_DBG_STATUS_ERROR;
    }

    if (ml_is_error(compile_state->Value)) {
        g_final_value = compile_state->Value;
        g_done = 1;
        mlk_set_output_cbs(NULL, NULL, NULL);
        return ML_DBG_STATUS_ERROR;
    }

    ml_value_t *main_fn = compile_state->Value;

    memset(&g_done_state, 0, sizeof(g_done_state));
    g_done_state.Type = MLStateT;
    g_done_state.Caller = NULL;
    g_done_state.Context = g_dbg_ctx;
    g_done_state.run = dbg_done_state_run;

    ml_call(&g_done_state, main_fn, 0, NULL);

    mlk_set_output_cbs(NULL, NULL, NULL);
    return dbg_current_status();
}

int ml_dbg_resume(
    int action,
    mld_stdout_cb stdout_cb,
    mld_display_cb display_cb,
    void *cb_ctx
) {
    if (!g_is_paused || !g_paused_state) {
        return dbg_current_status();
    }

    ml_state_t *frame = g_paused_state;
    ml_value_t *val = g_paused_value;
    g_paused_state = NULL;
    g_paused_value = NULL;
    g_is_paused = 0;
    g_pause_reason[0] = '\0';

    switch (action) {
        case ML_DBG_ACTION_STEP_IN:
            g_debugger.StepIn = 1;
            ml_debugger_step_mode(frame, 0, 0);
            g_expect_step = 1;
            break;
        case ML_DBG_ACTION_STEP_OVER:
            g_debugger.StepIn = 0;
            ml_debugger_step_mode(frame, 1, 0);
            g_expect_step = 1;
            break;
        case ML_DBG_ACTION_STEP_OUT: {
            g_debugger.StepIn = 0;
            ml_state_t *caller = frame->Caller;
            while (caller && !ml_debugger_check(caller)) {
                caller = caller->Caller;
            }
            if (caller) {
                /* Pause on the very next line after returning to the calling frame */
                ml_debugger_step_mode(frame, 0, 0);
                ml_debugger_step_mode(caller, 1, 0);
            } else {
                ml_debugger_step_mode(frame, 0, 1);
            }
            g_expect_step = 1;
            break;
        }
        case ML_DBG_ACTION_CONTINUE:
        default:
            g_debugger.StepIn = 0;
            ml_debugger_step_mode(frame, 0, 0);
            g_expect_step = 0;
            break;
    }

    mlk_set_output_cbs(stdout_cb, display_cb, cb_ctx);
    frame->run(frame, val);
    mlk_set_output_cbs(NULL, NULL, NULL);

    return dbg_current_status();
}

void ml_dbg_get_pause_info(
    char *reason_buf, size_t reason_cap,
    char *source_buf, size_t source_cap,
    int *line_out
) {
    if (reason_buf && reason_cap > 0) {
        snprintf(reason_buf, reason_cap, "%s", g_pause_reason);
    }
    if (source_buf && source_cap > 0) {
        source_buf[0] = '\0';
    }
    if (line_out) *line_out = 0;

    if (!g_is_paused || !g_paused_state) return;

    ml_state_t *frame = g_paused_state;
    while (frame && !ml_debugger_check(frame)) {
        frame = frame->Caller;
    }
    if (!frame) frame = g_paused_state;

    ml_source_t src = ml_debugger_source(frame);
    char norm[4096];
    dbg_normalize_source(src.Name, norm, sizeof(norm));
    if (source_buf && source_cap > 0) {
        snprintf(source_buf, source_cap, "%s", norm);
    }
    if (line_out) *line_out = src.Line;
}

static void dbg_format_value(ml_value_t *Val, char *type_buf, size_t type_cap, char *repr_buf, size_t repr_cap, int *is_nil_out) {
    if (!Val) {
        if (type_buf && type_cap > 0) snprintf(type_buf, type_cap, "nil");
        if (repr_buf && repr_cap > 0) snprintf(repr_buf, repr_cap, "nil");
        if (is_nil_out) *is_nil_out = 1;
        return;
    }
    if (ml_typeof(Val) == MLUninitializedT) {
        if (type_buf && type_cap > 0) snprintf(type_buf, type_cap, "uninitialized");
        if (repr_buf && repr_cap > 0) snprintf(repr_buf, repr_cap, "<uninitialized>");
        if (is_nil_out) *is_nil_out = 0;
        return;
    }
    Val = ml_deref(Val);
    if (!Val) {
        if (type_buf && type_cap > 0) snprintf(type_buf, type_cap, "nil");
        if (repr_buf && repr_cap > 0) snprintf(repr_buf, repr_cap, "nil");
        if (is_nil_out) *is_nil_out = 1;
        return;
    }
    const char *tname = (ml_typeof(Val) && ml_typeof(Val)->Name) ? ml_typeof(Val)->Name : "any";
    if (type_buf && type_cap > 0) snprintf(type_buf, type_cap, "%s", tname);
    if (is_nil_out) *is_nil_out = (Val == MLNil) ? 1 : 0;

    if (repr_buf && repr_cap > 0) {
        ml_stringbuffer_t sb[1] = {ML_STRINGBUFFER_INIT};
        ml_value_t *res = ml_stringbuffer_simple_append(sb, Val);
        if (ml_is_error(res)) {
            snprintf(repr_buf, repr_cap, "<%s>", tname);
        } else {
            size_t len = sb->Length;
            const char *s = ml_stringbuffer_get_string(sb);
            if (!s || len == 0) {
                repr_buf[0] = '\0';
            } else if (len >= repr_cap) {
                size_t copy_len = repr_cap > 4 ? repr_cap - 4 : 0;
                if (copy_len > 0) memcpy(repr_buf, s, copy_len);
                strcpy(repr_buf + copy_len, "...");
            } else {
                memcpy(repr_buf, s, len);
                repr_buf[len] = '\0';
            }
        }
    }
}

void ml_dbg_get_final_result(
    char *type_buf, size_t type_cap,
    char *repr_buf, size_t repr_cap,
    int *is_nil_out
) {
    dbg_format_value(g_final_value ? g_final_value : MLNil, type_buf, type_cap, repr_buf, repr_cap, is_nil_out);
}

void ml_dbg_get_error(
    char *type_buf, size_t type_cap,
    char *msg_buf, size_t msg_cap,
    char *tb_buf, size_t tb_cap
) {
    if (type_buf && type_cap > 0) type_buf[0] = '\0';
    if (msg_buf && msg_cap > 0) msg_buf[0] = '\0';
    if (tb_buf && tb_cap > 0) tb_buf[0] = '\0';

    ml_value_t *err = NULL;
    if (g_is_paused && g_paused_value && ml_is_error(g_paused_value)) {
        err = g_paused_value;
    } else if (g_final_value && ml_is_error(ml_deref(g_final_value))) {
        err = ml_deref(g_final_value);
    }
    if (!err) return;

    const char *et = ml_error_type(err);
    const char *em = ml_error_message(err);
    if (type_buf && type_cap > 0) snprintf(type_buf, type_cap, "%s", et ? et : "Error");
    if (msg_buf && msg_cap > 0) snprintf(msg_buf, msg_cap, "%s", em ? em : "");

    if (tb_buf && tb_cap > 0) {
        ml_stringbuffer_t tb[1] = {ML_STRINGBUFFER_INIT};
        ml_source_t src;
        int level = 0;
        while (ml_error_source(err, level++, &src)) {
            char norm[4096];
            dbg_normalize_source(src.Name, norm, sizeof(norm));
            ml_stringbuffer_printf(tb, "  at %s:%d\n", norm, src.Line);
        }
        const char *s = ml_stringbuffer_get_string(tb);
        snprintf(tb_buf, tb_cap, "%s", s ? s : "");
    }
}

static ml_state_t *dbg_find_frame(int depth) {
    if (!g_is_paused || !g_paused_state || depth < 0) return NULL;
    ml_state_t *frame = g_paused_state;
    int cur = 0;
    while (frame) {
        if (ml_debugger_check(frame)) {
            if (cur == depth) return frame;
            cur++;
        }
        frame = frame->Caller;
    }
    return NULL;
}

void ml_dbg_frames(mld_frame_cb cb, void *ctx) {
    if (!cb || !g_is_paused || !g_paused_state) return;
    ml_state_t *frame = g_paused_state;
    int depth = 0;
    while (frame) {
        if (ml_debugger_check(frame)) {
            ml_source_t src = ml_debugger_source(frame);
            char norm[4096];
            dbg_normalize_source(src.Name, norm, sizeof(norm));
            cb(depth, norm, src.Line, ctx);
            depth++;
        }
        frame = frame->Caller;
    }
}

void ml_dbg_locals(int depth, mld_local_cb cb, void *ctx) {
    if (!cb) return;
    ml_state_t *frame = dbg_find_frame(depth);
    if (!frame) return;

    stringmap_t seen[1] = {STRINGMAP_INIT};
    for (ml_decl_t *decl = ml_debugger_decls(frame); decl; decl = decl->Next) {
        if (!decl->Ident || !*decl->Ident) continue;
        if (stringmap_search(seen, decl->Ident)) continue;
        stringmap_insert(seen, decl->Ident, (void *)1);

        ml_value_t *val = decl->Value ? decl->Value : ml_debugger_local(frame, decl->Index);
        if (!val) continue;
        if (ml_is_error(val)) continue;

        char tbuf[128];
        char rbuf[512];
        int is_nil = 0;
        dbg_format_value(val, tbuf, sizeof(tbuf), rbuf, sizeof(rbuf), &is_nil);
        int is_upvalue = (decl->Value == NULL && decl->Index < 0) ? 1 : 0;
        cb(decl->Ident, tbuf, rbuf, decl->Source.Line, is_upvalue, ctx);
    }
}

static ml_value_t *dbg_frame_getter(ml_state_t *Frame, const char *Name, const char *Source, int Line, int Eval) {
    if (Frame) {
        for (ml_decl_t *decl = ml_debugger_decls(Frame); decl; decl = decl->Next) {
            if (decl->Ident && strcmp(decl->Ident, Name) == 0) {
                ml_value_t *val = decl->Value ? decl->Value : ml_debugger_local(Frame, decl->Index);
                if (val && !ml_is_error(val) && ml_typeof(val) != MLUninitializedT) {
                    return val;
                }
                break;
            }
        }
    }
    return ml_stringmap_global_get(MLGlobals, Name, Source, Line, Eval);
}

void ml_dbg_eval_in_frame(
    int depth,
    const char *expr,
    mld_stdout_cb stdout_cb,
    mld_display_cb display_cb,
    mld_result_cb result_cb,
    mld_error_cb error_cb,
    void *ctx
) {
    ml_state_t *frame = dbg_find_frame(depth);
    mlk_set_output_cbs(stdout_cb, display_cb, ctx);

    size_t len = expr ? strlen(expr) : 0;
    char *buf = snew(len + 2);
    if (len > 0) memcpy(buf, expr, len);
    if (len == 0 || buf[len - 1] != '\n') {
        buf[len] = '\n';
        buf[len + 1] = '\0';
    } else {
        buf[len] = '\0';
    }

    ml_parser_t *parser = ml_parser(NULL, NULL);
    ml_parser_source(parser, (ml_source_t){"<debug-eval>", 1, 0});
    ml_parser_input(parser, buf, 0);

    const mlc_expr_t *parsed = ml_accept_file(parser);
    if (!parsed) {
        ml_value_t *err = ml_parser_value(parser);
        if (error_cb) {
            const char *et = (err && ml_is_error(err)) ? ml_error_type(err) : "ParseError";
            const char *em = (err && ml_is_error(err)) ? ml_error_message(err) : "Invalid expression";
            error_cb(et ? et : "ParseError", em ? em : "Invalid expression", "", ctx);
        }
        mlk_set_output_cbs(NULL, NULL, NULL);
        return;
    }

    /* Compile & evaluate in MLRootContext (no debugger attached) so watch expressions never recurse */
    ml_compiler_t *compiler = ml_compiler2((ml_getter_t)dbg_frame_getter, frame, 0);
    dbg_sync_state_t cstate[1];
    memset(cstate, 0, sizeof(cstate));
    cstate->Base.Type = MLStateT;
    cstate->Base.Context = MLRootContext;
    cstate->Base.run = (ml_state_fn)dbg_sync_state_run;

    ml_function_compile((ml_state_t *)cstate, parsed, compiler, NULL);
    if (!cstate->Done || !cstate->Value || ml_is_error(cstate->Value)) {
        ml_value_t *err = cstate->Value;
        if (error_cb) {
            const char *et = (err && ml_is_error(err)) ? ml_error_type(err) : "CompileError";
            const char *em = (err && ml_is_error(err)) ? ml_error_message(err) : "Compile failed";
            error_cb(et ? et : "CompileError", em ? em : "Compile failed", "", ctx);
        }
        mlk_set_output_cbs(NULL, NULL, NULL);
        return;
    }

    dbg_sync_state_t estate[1];
    memset(estate, 0, sizeof(estate));
    estate->Base.Type = MLStateT;
    estate->Base.Context = MLRootContext;
    estate->Base.run = (ml_state_fn)dbg_sync_state_run;

    ml_call((ml_state_t *)estate, cstate->Value, 0, NULL);

    if (!estate->Done || !estate->Value) {
        if (result_cb) result_cb("nil", "nil", 3, 1, ctx);
        mlk_set_output_cbs(NULL, NULL, NULL);
        return;
    }

    ml_value_t *val = ml_deref(estate->Value);
    if (ml_is_error(val)) {
        if (error_cb) {
            const char *et = ml_error_type(val);
            const char *em = ml_error_message(val);
            error_cb(et ? et : "Error", em ? em : "", "", ctx);
        }
    } else if (result_cb) {
        char tbuf[128];
        char rbuf[4096];
        int is_nil = 0;
        dbg_format_value(val, tbuf, sizeof(tbuf), rbuf, sizeof(rbuf), &is_nil);
        result_cb(tbuf, rbuf, strlen(rbuf), is_nil, ctx);
    }

    mlk_set_output_cbs(NULL, NULL, NULL);
}
