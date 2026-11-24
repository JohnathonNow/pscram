#include "minilang.h"
#include "ml_compiler.h"
#include "ml_bytecode.h"
#include "ml_macros.h"
#include "ml_file.h"
#include "ml_object.h"
#include "ml_time.h"
#include "ml_debugger.h"
#include "ml_sequence.h"
#include "ml_stream.h"
#include "ml_logging.h"
#include "ml_socket.h"
#include "ml_cbor.h"
#include "ml_json.h"
#include "ml_uuid.h"
#include "ml_base16.h"
#include "ml_base64.h"
#include "ml_minijs.h"
#include "ml_module.h"
#include "ml_library.h"
#include "ml_ui.h"
#include "ml_io.h"
#include "ml_log.h"
#include "stringmap.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include <math.h>
#include <time.h>
#include <locale.h>
#include <sys/stat.h>
#include <unistd.h>

typedef void (*mlk_stdout_cb)(const char *data, size_t len, void *ctx);
typedef void (*mlk_display_cb)(const char *mime, const char *data, size_t len, void *ctx);
typedef void (*mlk_result_cb)(const char *type_name, const char *repr, size_t repr_len, int is_nil, void *ctx);
typedef void (*mlk_error_cb)(const char *err_type, const char *err_msg, const char *traceback, void *ctx);
typedef void (*mlk_var_cb)(const char *name, const char *type_name, const char *preview, int is_user, void *ctx);

/* Mirror of internal ml_compiler_t layout in minilang/src/ml_compiler.c */
struct ml_compiler_internal_t {
    ml_type_t *Type;
    ml_getter_t GlobalGet;
    void *Globals;
    stringmap_t Vars[1];
    int UseGlobals;
};

/* Required by libminilang.a */
stringmap_t MLGlobals[1] = {STRINGMAP_INIT};

extern ml_cfunction_t MLMemAddress[];
extern ml_cfunction_t MLMemTrace[];
extern ml_cfunction_t MLMemSize[];
extern ml_cfunction_t MLMemCollect[];
extern ml_cfunction_t MLMemUsage[];
extern ml_cfunction_t MLMemDump[];

static ml_compiler_t *g_compiler = NULL;
static ml_parser_t *g_parser = NULL;
static ml_value_t *g_last_value = NULL;

static mlk_stdout_cb g_stdout_cb = NULL;
static mlk_display_cb g_display_cb = NULL;
static void *g_cb_ctx = NULL;

static void mlk_emit_ui_display(const char *mime, const char *data, size_t len) {
    if (g_display_cb) {
        g_display_cb(mime, data, len, g_cb_ctx);
    }
}

typedef struct {
    ml_state_t Base;
    ml_value_t *Value;
    int Done;
} mlk_eval_state_t;

static void mlk_eval_state_run(mlk_eval_state_t *State, ml_value_t *Value) {
    State->Value = Value;
    State->Done = 1;
}

static int mlk_stringbuffer_emit_stdout(void *Unused, const char *String, size_t Length) {
    (void)Unused;
    if (g_stdout_cb && Length > 0) {
        g_stdout_cb(String, Length, g_cb_ctx);
    }
    return 0;
}

ML_FUNCTION(MLKNow) {
    return ml_integer(time(NULL));
}

ML_FUNCTION(MLKClock) {
    struct timespec Time[1];
    clock_gettime(CLOCK_REALTIME, Time);
    return ml_real(Time->tv_sec + Time->tv_nsec / 1000000000.0);
}

ML_FUNCTION(MLKPrint) {
    ml_stringbuffer_t Buffer[1] = {ML_STRINGBUFFER_INIT};
    for (int I = 0; I < Count; ++I) {
        ml_value_t *Result = ml_stringbuffer_simple_append(Buffer, Args[I]);
        if (ml_is_error(Result)) return Result;
    }
    ml_stringbuffer_drain(Buffer, NULL, mlk_stringbuffer_emit_stdout);
    return MLNil;
}

ML_FUNCTION(MLKPrintln) {
    ml_stringbuffer_t Buffer[1] = {ML_STRINGBUFFER_INIT};
    for (int I = 0; I < Count; ++I) {
        if (I > 0) ml_stringbuffer_write(Buffer, " ", 1);
        ml_value_t *Result = ml_stringbuffer_simple_append(Buffer, Args[I]);
        if (ml_is_error(Result)) return Result;
    }
    ml_stringbuffer_write(Buffer, "\n", 1);
    ml_stringbuffer_drain(Buffer, NULL, mlk_stringbuffer_emit_stdout);
    return MLNil;
}

static ml_value_t *mlk_emit_display_value(const char *Mime, ml_value_t *Val) {
    ml_stringbuffer_t Buffer[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Result = ml_stringbuffer_simple_append(Buffer, Val);
    if (ml_is_error(Result)) return Result;
    size_t Len = Buffer->Length;
    const char *Str = ml_stringbuffer_get_string(Buffer);
    if (g_display_cb) {
        g_display_cb(Mime, Str ? Str : "", Len, g_cb_ctx);
    }
    return MLNil;
}

ML_FUNCTION(MLKHtml) {
    ML_CHECK_ARG_COUNT(1);
    return mlk_emit_display_value("text/html", Args[0]);
}

ML_FUNCTION(MLKSvg) {
    ML_CHECK_ARG_COUNT(1);
    return mlk_emit_display_value("image/svg+xml", Args[0]);
}

ML_FUNCTION(MLKMarkdown) {
    ML_CHECK_ARG_COUNT(1);
    return mlk_emit_display_value("text/markdown", Args[0]);
}

static void mlk_json_write_str(ml_stringbuffer_t *sb, const char *s, size_t len);
static void mlk_write_base64(ml_stringbuffer_t *sb, const unsigned char *data, size_t len);

static const char *mlk_media_mime_for_path(const char *Path) {
    if (!Path) return NULL;
    const char *Dot = strrchr(Path, '.');
    if (!Dot || !Dot[1]) return NULL;
    const char *Ext = Dot + 1;
    if (strcasecmp(Ext, "png") == 0) return "image/png";
    if (strcasecmp(Ext, "jpg") == 0 || strcasecmp(Ext, "jpeg") == 0) return "image/jpeg";
    if (strcasecmp(Ext, "gif") == 0) return "image/gif";
    if (strcasecmp(Ext, "webp") == 0) return "image/webp";
    if (strcasecmp(Ext, "svg") == 0) return "image/svg+xml";
    if (strcasecmp(Ext, "bmp") == 0) return "image/bmp";
    if (strcasecmp(Ext, "ico") == 0) return "image/x-icon";
    if (strcasecmp(Ext, "avif") == 0) return "image/avif";
    if (strcasecmp(Ext, "pdf") == 0) return "application/pdf";
    return NULL;
}

static const char *mlk_detect_image_mime(const unsigned char *Data, size_t Len) {
    if (Len >= 8 && Data[0] == 0x89 && Data[1] == 'P' && Data[2] == 'N' && Data[3] == 'G') return "image/png";
    if (Len >= 3 && Data[0] == 0xFF && Data[1] == 0xD8 && Data[2] == 0xFF) return "image/jpeg";
    if (Len >= 6 && memcmp(Data, "GIF8", 4) == 0) return "image/gif";
    if (Len >= 12 && memcmp(Data, "RIFF", 4) == 0 && memcmp(Data + 8, "WEBP", 4) == 0) return "image/webp";
    if (Len >= 2 && Data[0] == 'B' && Data[1] == 'M') return "image/bmp";
    if (Len >= 5 && memcmp(Data, "%PDF-", 5) == 0) return "application/pdf";
    if (Len >= 4) {
        size_t i = 0;
        while (i < Len && (Data[i] == ' ' || Data[i] == '\t' || Data[i] == '\r' || Data[i] == '\n')) i++;
        if (i + 4 <= Len && (memcmp(Data + i, "<svg", 4) == 0 || memcmp(Data + i, "<?xm", 4) == 0)) {
            return "image/svg+xml";
        }
    }
    return "image/png";
}

static ml_value_t *mlk_emit_media_path(const char *Path, const char *ForceKind, const char *ExplicitMime) {
    char Resolved[4096];
    const char *Real = realpath(Path, Resolved);
    if (!Real) {
        return ml_error("FileError", "Media file '%s' not found", Path);
    }
    struct stat St;
    if (stat(Real, &St) != 0 || !S_ISREG(St.st_mode)) {
        return ml_error("FileError", "'%s' is not a regular file", Path);
    }

    const char *Mime = ExplicitMime ? ExplicitMime : mlk_media_mime_for_path(Real);
    const char *Kind = ForceKind;
    if (!Kind) {
        Kind = (Mime && strcmp(Mime, "application/pdf") == 0) ? "pdf" : "image";
    }
    if (!Mime) {
        Mime = (strcmp(Kind, "pdf") == 0) ? "application/pdf" : "image/png";
    }

    const char *BaseName = strrchr(Real, '/');
    BaseName = BaseName ? (BaseName + 1) : Real;

    /* If the file resides inside MINILANG_WORKSPACE_ROOT, emit a lightweight workspace media card
     * so the frontend streams it via /api/file/raw and opens it directly in a viewer tab on click! */
    const char *WsEnv = getenv("MINILANG_WORKSPACE_ROOT");
    char WsCanon[4096];
    if (WsEnv && *WsEnv && realpath(WsEnv, WsCanon)) {
        size_t WsLen = strlen(WsCanon);
        if (strncmp(Real, WsCanon, WsLen) == 0 && (Real[WsLen] == '/' || Real[WsLen] == '\0')) {
            const char *Rel = (Real[WsLen] == '/') ? (Real + WsLen + 1) : "";
            ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
            ml_stringbuffer_write(Sb, "{\"kind\":", 8);
            mlk_json_write_str(Sb, Kind, strlen(Kind));
            ml_stringbuffer_write(Sb, ",\"path\":", 8);
            mlk_json_write_str(Sb, Rel, strlen(Rel));
            ml_stringbuffer_write(Sb, ",\"mime\":", 8);
            mlk_json_write_str(Sb, Mime, strlen(Mime));
            ml_stringbuffer_write(Sb, ",\"name\":", 8);
            mlk_json_write_str(Sb, BaseName, strlen(BaseName));
            ml_stringbuffer_printf(Sb, ",\"size\":%" PRId64 "}", (int64_t)St.st_size);
            size_t Len = Sb->Length;
            const char *Json = ml_stringbuffer_get_string(Sb);
            if (g_display_cb) {
                g_display_cb("application/vnd.minilang.media+json", Json ? Json : "{}", Len, g_cb_ctx);
            }
            return MLNil;
        }
    }

    /* Outside workspace (e.g., /tmp/plot.png): read & base64-encode directly into display output */
    if (St.st_size > 20 * 1024 * 1024) {
        return ml_error("FileError", "Media file '%s' is too large to embed (> 20 MB)", Path);
    }
    FILE *Fp = fopen(Real, "rb");
    if (!Fp) return ml_error("FileError", "Failed to open '%s'", Path);
    size_t Size = (size_t)St.st_size;
    unsigned char *Buf = (unsigned char *)malloc(Size > 0 ? Size : 1);
    if (!Buf) { fclose(Fp); return ml_error("MemoryError", "Out of memory reading '%s'", Path); }
    size_t N = Size > 0 ? fread(Buf, 1, Size, Fp) : 0;
    fclose(Fp);

    if (strcmp(Mime, "image/svg+xml") == 0) {
        if (g_display_cb) g_display_cb("image/svg+xml", (const char *)Buf, N, g_cb_ctx);
        free(Buf);
        return MLNil;
    }

    ml_stringbuffer_t B64[1] = {ML_STRINGBUFFER_INIT};
    mlk_write_base64(B64, Buf, N);
    free(Buf);
    size_t B64Len = B64->Length;
    const char *B64Str = ml_stringbuffer_get_string(B64);
    if (g_display_cb) {
        g_display_cb(Mime, B64Str ? B64Str : "", B64Len, g_cb_ctx);
    }
    return MLNil;
}

static ml_value_t *mlk_emit_media_bytes(const unsigned char *Data, size_t Len, const char *ForceMime) {
    const char *Mime = ForceMime ? ForceMime : mlk_detect_image_mime(Data, Len);
    if (strcmp(Mime, "image/svg+xml") == 0) {
        if (g_display_cb) g_display_cb("image/svg+xml", (const char *)Data, Len, g_cb_ctx);
        return MLNil;
    }
    ml_stringbuffer_t B64[1] = {ML_STRINGBUFFER_INIT};
    mlk_write_base64(B64, Data, Len);
    size_t B64Len = B64->Length;
    const char *B64Str = ml_stringbuffer_get_string(B64);
    if (g_display_cb) {
        g_display_cb(Mime, B64Str ? B64Str : "", B64Len, g_cb_ctx);
    }
    return MLNil;
}

ML_FUNCTION(MLKImage) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Arg = ml_deref(Args[0]);
    const char *ExplicitMime = NULL;
    if (Count >= 2 && ml_is(ml_deref(Args[1]), MLStringT)) {
        ExplicitMime = ml_string_value(ml_deref(Args[1]));
    }
    if (ml_is(Arg, MLStringT)) {
        return mlk_emit_media_path(ml_string_value(Arg), "image", ExplicitMime);
    }
    if (ml_is(Arg, MLAddressT)) {
        return mlk_emit_media_bytes((const unsigned char *)ml_address_value(Arg), (size_t)ml_address_length(Arg), ExplicitMime);
    }
    return ml_error("TypeError", "image() expects a file path string or raw bytes (address)");
}

ML_FUNCTION(MLKPdf) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Arg = ml_deref(Args[0]);
    if (ml_is(Arg, MLStringT)) {
        return mlk_emit_media_path(ml_string_value(Arg), "pdf", "application/pdf");
    }
    if (ml_is(Arg, MLAddressT)) {
        return mlk_emit_media_bytes((const unsigned char *)ml_address_value(Arg), (size_t)ml_address_length(Arg), "application/pdf");
    }
    return ml_error("TypeError", "pdf() expects a file path string or raw bytes (address)");
}

ML_FUNCTION(MLKPreview) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Arg = ml_deref(Args[0]);
    if (ml_is(Arg, MLStringT)) {
        return mlk_emit_media_path(ml_string_value(Arg), NULL, NULL);
    }
    if (ml_is(Arg, MLAddressT)) {
        return mlk_emit_media_bytes((const unsigned char *)ml_address_value(Arg), (size_t)ml_address_length(Arg), NULL);
    }
    return ml_error("TypeError", "preview() expects a file path string or raw bytes (address)");
}

ML_FUNCTION(MLKDisplay) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    const char *Mime = ml_string_value(Args[0]);
    return mlk_emit_display_value(Mime, Args[1]);
}

ML_FUNCTION(MLKLocale) {
    return ml_string(setlocale(LC_ALL, NULL), -1);
}

ML_FUNCTION(MLKHalt) {
    if (Count > 0) {
        ML_CHECK_ARG_TYPE(0, MLIntegerT);
        exit((int)ml_integer_value(Args[0]));
    } else {
        exit(0);
    }
}

ML_FUNCTION(MLKNullFn) {
    return NULL;
}

static int mlk_globals_add(const char *Name, ml_value_t *Value, ml_value_t *Result) {
    ml_map_insert(Result, ml_string(Name, -1), Value);
    return 0;
}

static ml_value_t *mlk_globals(stringmap_t *Globals, int Count, ml_value_t **Args) {
    (void)Count;
    (void)Args;
    ml_value_t *Result = ml_map();
    stringmap_foreach(Globals, Result, (void *)mlk_globals_add);
    return Result;
}

/* --- Module / Import Support for .mini Scripts & Notebooks --- */

extern const char *ml_load_file_read(void *Data);

static int mlk_test_exact_mini(const char *FileName) {
    if (!FileName) return 0;
    size_t Len = strlen(FileName);
    if (Len < 5 || strcmp(FileName + Len - 5, ".mini") != 0) return 0;
    struct stat St;
    return stat(FileName, &St) == 0 && S_ISREG(St.st_mode);
}

static void mlk_load_exact_mini(ml_state_t *Caller, const char *FileName, ml_value_t **Slot) {
    FILE *File = fopen(FileName, "r");
    if (!File) ML_ERROR("LoadError", "error opening %s", FileName);
    ml_parser_t *Parser = ml_parser(ml_load_file_read, File);
    int LineNo = 1;
    const char *Line = ml_load_file_read(File);
    if (!Line) ML_ERROR("LoadError", "empty file %s", FileName);
    if (Line[0] == '#' && Line[1] == '!') {
        LineNo = 2;
        Line = ml_load_file_read(File);
        if (!Line) ML_ERROR("LoadError", "empty file %s", FileName);
    }
    ml_parser_source(Parser, (ml_source_t){FileName, LineNo});
    ml_parser_input(Parser, Line, 0);
    const mlc_expr_t *Expr = ml_accept_file(Parser);
    if (!Expr) ML_RETURN(ml_parser_value(Parser));
    ml_compiler_t *Compiler = ml_compiler((ml_getter_t)ml_stringmap_global_get, MLGlobals);
    ml_compiler_define(Compiler, "import", ml_library_importer(FileName));
    return ml_module_compile(Caller, FileName, Expr, Compiler, Slot);
}

/* Dynamic top-level importer:
 * - Calling `import(Name)` resolves relative `./` / `../` paths against current working directory
 *   (so notebooks and `/invoke` scripts always resolve relative imports accurately even after `chdir`),
 *   absolute `/...` paths directly, and bare names via `library::get_path()` search paths.
 * - Stringifying `import` (`string(import)`, `'{import}/file.cbor'`, `print(import)`) appends the
 *   current directory path, matching Minilang's built-in `MLImporterT` in `ml_library.c`. */
typedef struct {
    ml_type_t *Type;
} mlk_importer_t;

static void mlk_importer_call(ml_state_t *Caller, mlk_importer_t *Importer, int Count, ml_value_t **Args) {
    (void)Importer;
    ML_CHECKX_ARG_COUNT(1);
    ml_value_t *NameArg = ml_deref(Args[0]);
    if (!ml_is(NameArg, MLStringT)) {
        ML_ERROR("TypeError", "Expected string for import path");
    }
    const char *Name = ml_string_value(NameArg);
    if (Name[0] == '.') {
        char *Cwd = getcwd(NULL, 0);
        if (!Cwd) ML_ERROR("ModuleError", "Could not determine working directory");
        char *GcCwd = snew(strlen(Cwd) + 1);
        strcpy(GcCwd, Cwd);
        free(Cwd);
        return ml_library_load(Caller, GcCwd, Name);
    }
    if (Name[0] == '/') {
        return ml_library_load(Caller, "/", Name + 1);
    }
    return ml_library_load(Caller, NULL, Name);
}

static ml_value_t *mlk_importer_append(void *Data, int Count, ml_value_t **Args) {
    (void)Data;
    (void)Count;
    ml_stringbuffer_t *Buffer = (ml_stringbuffer_t *)Args[0];
    char *Cwd = getcwd(NULL, 0);
    if (!Cwd) return MLNil;
    ml_stringbuffer_write(Buffer, Cwd, strlen(Cwd));
    free(Cwd);
    return MLSome;
}

ML_TYPE(MLKImporterT, (MLFunctionT), "importer",
    .call = (void *)mlk_importer_call
);

static mlk_importer_t MLKImportObj[1] = {{MLKImporterT}};

/* Top-level fallback `export`: allows `.mini` library modules using `export: fun ...` / `export: let ...`
 * to also be executed directly via `/invoke` or the editor Run button without failing.
 * When imported as a module, `ml_module_compile` shadows `export` with `ml_mini_module_export`. */
ML_FUNCTIONX(MLKTopLevelExport) {
    if (Count == 0) ML_RETURN(MLNil);
    ml_value_t *Last = MLNil;
    if (ml_is(ml_deref(Args[0]), MLNamesT)) {
        for (int I = 1; I < Count; ++I) {
            Last = ml_deref(Args[I]);
        }
    } else {
        Last = ml_deref(Args[Count - 1]);
    }
    ML_RETURN(Last);
}

void mlk_add_library_path(const char *path) {
    if (!path || !*path) return;
    struct stat St;
    if (stat(path, &St) == 0 && S_ISDIR(St.st_mode)) {
        size_t len = strlen(path);
        char *gc_copy = snew(len + 1);
        memcpy(gc_copy, path, len + 1);
        ml_library_path_add(gc_copy);
    }
}

void mlk_init(const char *exec_name) {
    ml_init(exec_name ? exec_name : "minilang", MLGlobals);
    ml_time_init(MLGlobals);

    stringmap_insert(MLGlobals, "null", MLKNullFn);
    stringmap_insert(MLGlobals, "now", MLKNow);
    stringmap_insert(MLGlobals, "clock", MLKClock);
    stringmap_insert(MLGlobals, "print", MLKPrint);
    stringmap_insert(MLGlobals, "println", MLKPrintln);
    stringmap_insert(MLGlobals, "html", MLKHtml);
    stringmap_insert(MLGlobals, "svg", MLKSvg);
    stringmap_insert(MLGlobals, "markdown", MLKMarkdown);
    stringmap_insert(MLGlobals, "image", MLKImage);
    stringmap_insert(MLGlobals, "pdf", MLKPdf);
    stringmap_insert(MLGlobals, "preview", MLKPreview);
    stringmap_insert(MLGlobals, "display", MLKDisplay);
    stringmap_insert(MLGlobals, "locale", MLKLocale);
    stringmap_insert(MLGlobals, "halt", MLKHalt);
    stringmap_insert(MLGlobals, "break", MLBreak);
    stringmap_insert(MLGlobals, "debugger", MLDebugger);
    stringmap_insert(MLGlobals, "trace", MLTrace);
    stringmap_insert(MLGlobals, "memory", ml_module("memory",
        "address", MLMemAddress,
        "trace", MLMemTrace,
        "size", MLMemSize,
        "collect", MLMemCollect,
        "usage", MLMemUsage,
        "dump", MLMemDump,
        NULL));
    stringmap_insert(MLGlobals, "callcc", MLCallCC);
    stringmap_insert(MLGlobals, "markcc", MLMarkCC);
    stringmap_insert(MLGlobals, "calldc", MLCallDC);
    stringmap_insert(MLGlobals, "swapcc", MLSwapCC);
    stringmap_insert(MLGlobals, "channel", MLChannelT);
    stringmap_insert(MLGlobals, "semaphore", MLSemaphoreT);
    stringmap_insert(MLGlobals, "condition", MLConditionT);
    stringmap_insert(MLGlobals, "rwlock", MLRWLockT);
    stringmap_insert(MLGlobals, "finalize", MLFinalizer);
    stringmap_insert(MLGlobals, "context", MLContextKeyT);
    stringmap_insert(MLGlobals, "parser", MLParserT);
    stringmap_insert(MLGlobals, "compiler", MLCompilerT);
    stringmap_insert(MLGlobals, "macro", MLMacroT);
    stringmap_insert(MLGlobals, "variable", MLVariableT);
    stringmap_insert(MLGlobals, "global", ml_stringmap_globals(MLGlobals));
    stringmap_insert(MLGlobals, "globals", ml_cfunction(MLGlobals, (void *)mlk_globals));

    ml_logging_init(MLGlobals);
    ml_stream_init(MLGlobals);
    ml_file_init(MLGlobals);
    ml_socket_init(MLGlobals);
    ml_cbor_init(MLGlobals);
    ml_json_init(MLGlobals);
    ml_uuid_init(MLGlobals);
    ml_base16_init(MLGlobals);
    ml_base64_init(MLGlobals);
    ml_minijs_init(MLGlobals);
    ml_module_init(MLGlobals);
    ml_library_init(MLGlobals);

    /* Allow both `import("foo")` and `import("foo.mini")` (and relative `./foo.mini`) */
    ml_library_loader_add("", mlk_test_exact_mini, mlk_load_exact_mini, NULL);
    /* Initialize MLKImporterT + its `append` method so string(import) yields the current script/notebook directory */
    ml_type_init(MLKImporterT, MLFunctionT, NULL);
    ml_method_definev(
        ml_method("append"),
        ml_cfunction(NULL, (ml_callback_t)mlk_importer_append),
        NULL,
        MLStringBufferT,
        MLKImporterT,
        NULL
    );
    /* Use dynamic CWD-aware importer at top-level (modules loaded via ml_library still get per-file importers) */
    stringmap_insert(MLGlobals, "import", MLKImportObj);
    stringmap_insert(MLGlobals, "export", MLKTopLevelExport);

    ml_externals_default_add("print", MLKPrint);
    ml_externals_default_add("println", MLKPrintln);
    ml_externals_default_add("now", MLKNow);
    ml_externals_default_add("clock", MLKClock);
    ml_externals_default_add("html", MLKHtml);
    ml_externals_default_add("svg", MLKSvg);
    ml_externals_default_add("markdown", MLKMarkdown);
    ml_externals_default_add("image", MLKImage);
    ml_externals_default_add("pdf", MLKPdf);
    ml_externals_default_add("preview", MLKPreview);
    ml_externals_default_add("json", MLJsonT);
    ml_externals_default_add("time", MLTimeT);
    ml_externals_default_add("uuid", MLUUIDT);
    ml_externals_default_add("import", MLKImportObj);
    ml_externals_default_add("library", stringmap_search(MLGlobals, "library"));

    ml_ui_init(MLGlobals, mlk_emit_ui_display);
    ml_io_init(MLGlobals);
    ml_log_init(MLGlobals);

    g_compiler = ml_compiler2((ml_getter_t)ml_stringmap_global_get, MLGlobals, 1);
    g_parser = ml_parser(NULL, NULL);
}

static void mlk_emit_error(ml_value_t *Err, mlk_error_cb error_cb, void *ctx) {
    if (!error_cb) return;
    const char *err_type = ml_error_type(Err);
    const char *err_msg = ml_error_message(Err);
    ml_stringbuffer_t tb[1] = {ML_STRINGBUFFER_INIT};
    ml_source_t src;
    int level = 0;
    while (ml_error_source(Err, level++, &src)) {
        ml_stringbuffer_printf(tb, "  at %s:%d\n", src.Name ? src.Name : "<unknown>", src.Line);
    }
    const char *tb_str = ml_stringbuffer_get_string(tb);
    error_cb(
        err_type ? err_type : "Error",
        err_msg ? err_msg : "",
        tb_str ? tb_str : "",
        ctx
    );
}

void mlk_eval(
    const char *source_name,
    const char *code,
    mlk_stdout_cb stdout_cb,
    mlk_display_cb display_cb,
    mlk_result_cb result_cb,
    mlk_error_cb error_cb,
    void *ctx
) {
    g_stdout_cb = stdout_cb;
    g_display_cb = display_cb;
    g_cb_ctx = ctx;

    size_t len = code ? strlen(code) : 0;
    char *buf = snew(len + 2);
    if (len > 0) memcpy(buf, code, len);
    if (len == 0 || buf[len - 1] != '\n') {
        buf[len] = '\n';
        buf[len + 1] = '\0';
    } else {
        buf[len] = '\0';
    }

    char *src_copy = snew((source_name ? strlen(source_name) : 6) + 1);
    strcpy(src_copy, source_name ? source_name : "<cell>");

    ml_parser_reset(g_parser);
    ml_parser_source(g_parser, (ml_source_t){src_copy, 1, 0});
    ml_parser_input(g_parser, buf, 0);
    g_last_value = MLNil;

    for (;;) {
        mlk_eval_state_t State[1];
        memset(State, 0, sizeof(State));
        State->Base.Type = MLStateT;
        State->Base.Caller = NULL;
        State->Base.Context = MLRootContext;
        State->Base.run = (ml_state_fn)mlk_eval_state_run;
        State->Value = NULL;
        State->Done = 0;

        ml_command_evaluate((ml_state_t *)State, g_parser, g_compiler);

        if (!State->Done || State->Value == MLEndOfInput) {
            break;
        }

        ml_value_t *Val = State->Value;
        if (!Val) {
            break;
        }
        Val = ml_deref(Val);
        if (ml_is_error(Val)) {
            g_last_value = MLNil;
            mlk_emit_error(Val, error_cb, ctx);
            ml_parser_reset(g_parser);
            break;
        }
        g_last_value = Val;

        const char *type_name = ml_typeof(Val) && ml_typeof(Val)->Name ? ml_typeof(Val)->Name : "any";
        int is_nil = (Val == MLNil) ? 1 : 0;

        ml_stringbuffer_t sb[1] = {ML_STRINGBUFFER_INIT};
        ml_value_t *StrRes = ml_stringbuffer_simple_append(sb, Val);
        if (ml_is_error(StrRes)) {
            mlk_emit_error(StrRes, error_cb, ctx);
            ml_parser_reset(g_parser);
            break;
        }
        size_t repr_len = sb->Length;
        const char *repr = ml_stringbuffer_get_string(sb);
        if (result_cb) {
            result_cb(type_name, repr ? repr : "", repr_len, is_nil, ctx);
        }
    }

    ml_parser_reset(g_parser);
    g_stdout_cb = NULL;
    g_display_cb = NULL;
    g_cb_ctx = NULL;
}

typedef struct {
    mlk_var_cb cb;
    void *ctx;
    int is_user;
} mlk_var_iter_t;

static int mlk_var_foreach(const char *Name, void *RawVal, void *Data) {
    mlk_var_iter_t *Iter = (mlk_var_iter_t *)Data;
    ml_value_t *Val = (ml_value_t *)RawVal;
    if (!Val) {
        Iter->cb(Name, "null", "null", Iter->is_user, Iter->ctx);
        return 0;
    }
    if (ml_typeof(Val) == MLGlobalT) {
        Val = ml_global_get(Val);
        if (!Val) {
            return 0;
        }
    }
    if (ml_typeof(Val) == MLUninitializedT) {
        return 0;
    }
    Val = ml_deref(Val);
    if (!Val) {
        Iter->cb(Name, "null", "null", Iter->is_user, Iter->ctx);
        return 0;
    }
    const char *type_name = (ml_typeof(Val) && ml_typeof(Val)->Name) ? ml_typeof(Val)->Name : "any";

    char preview_buf[300];
    if (Iter->is_user) {
        ml_stringbuffer_t sb[1] = {ML_STRINGBUFFER_INIT};
        ml_value_t *Res = ml_stringbuffer_simple_append(sb, Val);
        if (ml_is_error(Res)) {
            snprintf(preview_buf, sizeof(preview_buf), "<%s>", type_name);
        } else {
            size_t len = sb->Length;
            const char *s = ml_stringbuffer_get_string(sb);
            if (!s || len == 0) {
                preview_buf[0] = '\0';
            } else if (len > 240) {
                memcpy(preview_buf, s, 240);
                strcpy(preview_buf + 240, "...");
            } else {
                memcpy(preview_buf, s, len);
                preview_buf[len] = '\0';
            }
        }
    } else {
        snprintf(preview_buf, sizeof(preview_buf), "<%s>", type_name);
    }

    Iter->cb(Name, type_name, preview_buf, Iter->is_user, Iter->ctx);
    return 0;
}

void mlk_list_vars(mlk_var_cb cb, void *ctx) {
    if (!cb) return;
    if (g_compiler) {
        struct ml_compiler_internal_t *Internal = (struct ml_compiler_internal_t *)g_compiler;
        mlk_var_iter_t user_iter = { cb, ctx, 1 };
        stringmap_foreach(Internal->Vars, &user_iter, mlk_var_foreach);
    }
    mlk_var_iter_t global_iter = { cb, ctx, 0 };
    stringmap_foreach(MLGlobals, &global_iter, mlk_var_foreach);
}

/* --- Tagged Value FFI Builders & Script Invoke Helpers --- */

void *mlk_val_nil(void) {
    return (void *)MLNil;
}

void *mlk_val_bool(int v) {
    return (void *)ml_boolean(v);
}

void *mlk_val_int(int64_t v) {
    return (void *)ml_integer(v);
}

void *mlk_val_real(double v) {
    return (void *)ml_real(v);
}

void *mlk_val_string(const char *ptr, size_t len) {
    if (!ptr || len == 0) return (void *)ml_string("", 0);
    return (void *)ml_string_copy(ptr, (int)len);
}

void *mlk_val_symbol(const char *name) {
    return (void *)ml_method(name ? name : "");
}

void *mlk_val_bytes(const unsigned char *ptr, size_t len) {
    char *copy = snew(len > 0 ? len : 1);
    if (len > 0 && ptr) memcpy(copy, ptr, len);
    return (void *)ml_address(copy, (int)len);
}

void *mlk_val_time_str(const char *iso, size_t len, char *err_buf, size_t err_cap) {
    ml_value_t *v = ml_time_parse(iso ? iso : "", (int)len);
    if (ml_is_error(v)) {
        if (err_buf && err_cap > 0) {
            snprintf(err_buf, err_cap, "%s: %s", ml_error_type(v), ml_error_message(v));
        }
        return NULL;
    }
    return (void *)v;
}

void *mlk_val_time_epoch(int64_t sec, uint64_t nsec) {
    return (void *)ml_time((time_t)sec, (unsigned long)nsec);
}

void *mlk_val_uuid(const char *str, size_t len, char *err_buf, size_t err_cap) {
    ml_value_t *v = ml_uuid_parse(str ? str : "", (int)len);
    if (ml_is_error(v)) {
        if (err_buf && err_cap > 0) {
            snprintf(err_buf, err_cap, "%s: %s", ml_error_type(v), ml_error_message(v));
        }
        return NULL;
    }
    return (void *)v;
}

void *mlk_val_list_new(void) {
    return (void *)ml_list();
}

void mlk_val_list_put(void *list, void *item) {
    ml_list_put((ml_value_t *)list, (ml_value_t *)item);
}

void *mlk_val_tuple_new(void *const *items, size_t count) {
    ml_value_t *t = ml_tuple(count);
    for (size_t i = 0; i < count; ++i) {
        ml_tuple_set(t, (int)(i + 1), (ml_value_t *)items[i]);
    }
    return (void *)t;
}

void *mlk_val_set_new(void) {
    return (void *)ml_set();
}

void mlk_val_set_insert(void *set, void *item) {
    ml_set_insert((ml_value_t *)set, (ml_value_t *)item);
}

void *mlk_val_map_new(void) {
    return (void *)ml_map();
}

void mlk_val_map_insert(void *map, void *key, void *val) {
    ml_map_insert((ml_value_t *)map, (ml_value_t *)key, (ml_value_t *)val);
}

void mlk_define(const char *name, void *val) {
    if (!g_compiler || !name) return;
    size_t n = strlen(name);
    char *copy = snew(n + 1);
    memcpy(copy, name, n + 1);
    ml_compiler_define(g_compiler, copy, (ml_value_t *)val);
}

void mlk_call_function(
    const char *fn_name,
    void *const *args,
    size_t argc,
    mlk_stdout_cb stdout_cb,
    mlk_display_cb display_cb,
    mlk_result_cb result_cb,
    mlk_error_cb error_cb,
    void *ctx
) {
    g_stdout_cb = stdout_cb;
    g_display_cb = display_cb;
    g_cb_ctx = ctx;

    ml_value_t *fn = ml_compiler_lookup(g_compiler, fn_name, "<invoke>", 1, 0);
    if (!fn || ml_typeof(fn) == MLUninitializedT) {
        if (error_cb) error_cb("NameError", "Function not defined in script", "", ctx);
        goto cleanup;
    }
    if (ml_typeof(fn) == MLGlobalT) {
        fn = ml_global_get(fn);
    }
    if (!fn || ml_typeof(fn) == MLUninitializedT) {
        if (error_cb) error_cb("NameError", "Function is uninitialized", "", ctx);
        goto cleanup;
    }
    fn = ml_deref(fn);
    if (ml_is_error(fn)) {
        mlk_emit_error(fn, error_cb, ctx);
        goto cleanup;
    }

    ml_value_t **ml_args = argc > 0 ? anew(ml_value_t *, argc) : NULL;
    for (size_t i = 0; i < argc; ++i) {
        ml_args[i] = (ml_value_t *)args[i];
    }

    mlk_eval_state_t State[1];
    memset(State, 0, sizeof(State));
    State->Base.Type = MLStateT;
    State->Base.Caller = NULL;
    State->Base.Context = MLRootContext;
    State->Base.run = (ml_state_fn)mlk_eval_state_run;
    State->Value = NULL;
    State->Done = 0;

    ml_call((ml_state_t *)State, fn, (int)argc, ml_args);

    if (!State->Done || !State->Value) {
        g_last_value = MLNil;
        goto cleanup;
    }

    ml_value_t *Val = ml_deref(State->Value);
    if (ml_is_error(Val)) {
        g_last_value = MLNil;
        mlk_emit_error(Val, error_cb, ctx);
        goto cleanup;
    }
    g_last_value = Val;

    const char *type_name = (ml_typeof(Val) && ml_typeof(Val)->Name) ? ml_typeof(Val)->Name : "any";
    int is_nil = (Val == MLNil) ? 1 : 0;
    ml_stringbuffer_t sb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *StrRes = ml_stringbuffer_simple_append(sb, Val);
    if (ml_is_error(StrRes)) {
        mlk_emit_error(StrRes, error_cb, ctx);
        goto cleanup;
    }
    size_t repr_len = sb->Length;
    const char *repr = ml_stringbuffer_get_string(sb);
    if (result_cb) {
        result_cb(type_name, repr ? repr : "", repr_len, is_nil, ctx);
    }

cleanup:
    g_stdout_cb = NULL;
    g_display_cb = NULL;
    g_cb_ctx = NULL;
}

static void mlk_json_write_str(ml_stringbuffer_t *sb, const char *s, size_t len) {
    ml_stringbuffer_write(sb, "\"", 1);
    for (size_t i = 0; i < len; ++i) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  ml_stringbuffer_write(sb, "\\\"", 2); break;
            case '\\': ml_stringbuffer_write(sb, "\\\\", 2); break;
            case '\b': ml_stringbuffer_write(sb, "\\b", 2); break;
            case '\f': ml_stringbuffer_write(sb, "\\f", 2); break;
            case '\n': ml_stringbuffer_write(sb, "\\n", 2); break;
            case '\r': ml_stringbuffer_write(sb, "\\r", 2); break;
            case '\t': ml_stringbuffer_write(sb, "\\t", 2); break;
            default:
                if (c < 0x20) {
                    ml_stringbuffer_printf(sb, "\\u%04x", c);
                } else {
                    ml_stringbuffer_put(sb, (char)c);
                }
                break;
        }
    }
    ml_stringbuffer_write(sb, "\"", 1);
}

static void mlk_write_base64(ml_stringbuffer_t *sb, const unsigned char *data, size_t len) {
    static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (size_t i = 0; i < len; i += 3) {
        uint32_t b0 = data[i];
        uint32_t b1 = (i + 1 < len) ? data[i + 1] : 0;
        uint32_t b2 = (i + 2 < len) ? data[i + 2] : 0;
        uint32_t n = (b0 << 16) | (b1 << 8) | b2;
        char chunk[4];
        chunk[0] = tbl[(n >> 18) & 63];
        chunk[1] = tbl[(n >> 12) & 63];
        chunk[2] = (i + 1 < len) ? tbl[(n >> 6) & 63] : '=';
        chunk[3] = (i + 2 < len) ? tbl[n & 63] : '=';
        ml_stringbuffer_write(sb, chunk, 4);
    }
}

static void mlk_write_tagged_json(ml_stringbuffer_t *sb, ml_value_t *Val, int depth) {
    if (!Val) {
        ml_stringbuffer_write(sb, "{\"type\":\"nil\"}", 14);
        return;
    }
    Val = ml_deref(Val);
    if (!Val || Val == MLNil) {
        ml_stringbuffer_write(sb, "{\"type\":\"nil\"}", 14);
        return;
    }
    if (depth > 32) {
        ml_stringbuffer_write(sb, "{\"type\":\"string\",\"value\":\"<max depth>\"}", 39);
        return;
    }
    if (ml_is(Val, MLBooleanT)) {
        if (ml_boolean_value(Val)) {
            ml_stringbuffer_write(sb, "{\"type\":\"boolean\",\"value\":true}", 31);
        } else {
            ml_stringbuffer_write(sb, "{\"type\":\"boolean\",\"value\":false}", 32);
        }
    } else if (ml_is(Val, MLIntegerT)) {
        ml_stringbuffer_printf(sb, "{\"type\":\"integer\",\"value\":%" PRId64 "}", ml_integer_value(Val));
    } else if (ml_is(Val, MLRealT)) {
        double d = ml_real_value(Val);
        if (isnan(d) || isinf(d)) {
            ml_stringbuffer_write(sb, "{\"type\":\"real\",\"value\":null}", 28);
        } else {
            ml_stringbuffer_printf(sb, "{\"type\":\"real\",\"value\":%.17g}", d);
        }
    } else if (ml_is(Val, MLStringT)) {
        ml_stringbuffer_write(sb, "{\"type\":\"string\",\"value\":", 25);
        mlk_json_write_str(sb, ml_string_value(Val), ml_string_length(Val));
        ml_stringbuffer_write(sb, "}", 1);
    } else if (ml_is(Val, MLMethodT)) {
        const char *mname = ml_method_name(Val);
        ml_stringbuffer_write(sb, "{\"type\":\"symbol\",\"value\":", 25);
        mlk_json_write_str(sb, mname ? mname : "", mname ? strlen(mname) : 0);
        ml_stringbuffer_write(sb, "}", 1);
    } else if (ml_is(Val, MLListT)) {
        ml_stringbuffer_write(sb, "{\"type\":\"list\",\"value\":[", 24);
        int first = 1;
        ML_LIST_FOREACH(Val, Node) {
            if (!first) ml_stringbuffer_write(sb, ",", 1);
            first = 0;
            mlk_write_tagged_json(sb, Node->Value, depth + 1);
        }
        ml_stringbuffer_write(sb, "]}", 2);
    } else if (ml_is(Val, MLTupleT)) {
        int n = ml_tuple_size(Val);
        ml_stringbuffer_write(sb, "{\"type\":\"tuple\",\"value\":[", 25);
        for (int i = 1; i <= n; ++i) {
            if (i > 1) ml_stringbuffer_write(sb, ",", 1);
            mlk_write_tagged_json(sb, ml_tuple_get(Val, i), depth + 1);
        }
        ml_stringbuffer_write(sb, "]}", 2);
    } else if (ml_is(Val, MLSetT)) {
        ml_stringbuffer_write(sb, "{\"type\":\"set\",\"value\":[", 23);
        int first = 1;
        ML_SET_FOREACH(Val, Node) {
            if (!first) ml_stringbuffer_write(sb, ",", 1);
            first = 0;
            mlk_write_tagged_json(sb, Node->Key, depth + 1);
        }
        ml_stringbuffer_write(sb, "]}", 2);
    } else if (ml_is(Val, MLMapT)) {
        int all_str = 1;
        ML_MAP_FOREACH(Val, Node) {
            if (!ml_is(ml_deref(Node->Key), MLStringT)) {
                all_str = 0;
                break;
            }
        }
        if (all_str) {
            ml_stringbuffer_write(sb, "{\"type\":\"map\",\"value\":{", 23);
            int first = 1;
            ML_MAP_FOREACH(Val, Node) {
                if (!first) ml_stringbuffer_write(sb, ",", 1);
                first = 0;
                ml_value_t *k = ml_deref(Node->Key);
                mlk_json_write_str(sb, ml_string_value(k), ml_string_length(k));
                ml_stringbuffer_write(sb, ":", 1);
                mlk_write_tagged_json(sb, Node->Value, depth + 1);
            }
            ml_stringbuffer_write(sb, "}}", 2);
        } else {
            ml_stringbuffer_write(sb, "{\"type\":\"map\",\"value\":[", 23);
            int first = 1;
            ML_MAP_FOREACH(Val, Node) {
                if (!first) ml_stringbuffer_write(sb, ",", 1);
                first = 0;
                ml_stringbuffer_write(sb, "[", 1);
                mlk_write_tagged_json(sb, Node->Key, depth + 1);
                ml_stringbuffer_write(sb, ",", 1);
                mlk_write_tagged_json(sb, Node->Value, depth + 1);
                ml_stringbuffer_write(sb, "]", 1);
            }
            ml_stringbuffer_write(sb, "]}", 2);
        }
    } else if (ml_is(Val, MLTimeT)) {
        struct timespec ts;
        ml_time_value(Val, &ts);
        struct tm utc;
        gmtime_r(&ts.tv_sec, &utc);
        char iso[64];
        if (ts.tv_nsec > 0) {
            snprintf(
                iso, sizeof(iso),
                "%04d-%02d-%02dT%02d:%02d:%02d.%09luZ",
                utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
                utc.tm_hour, utc.tm_min, utc.tm_sec,
                (unsigned long)ts.tv_nsec
            );
        } else {
            snprintf(
                iso, sizeof(iso),
                "%04d-%02d-%02dT%02d:%02d:%02dZ",
                utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
                utc.tm_hour, utc.tm_min, utc.tm_sec
            );
        }
        ml_stringbuffer_write(sb, "{\"type\":\"time\",\"value\":", 23);
        mlk_json_write_str(sb, iso, strlen(iso));
        ml_stringbuffer_write(sb, "}", 1);
    } else if (ml_is(Val, MLUUIDT)) {
        ml_stringbuffer_t tmp[1] = {ML_STRINGBUFFER_INIT};
        ml_stringbuffer_simple_append(tmp, Val);
        size_t len = tmp->Length;
        const char *s = ml_stringbuffer_get_string(tmp);
        ml_stringbuffer_write(sb, "{\"type\":\"uuid\",\"value\":", 23);
        mlk_json_write_str(sb, s ? s : "", len);
        ml_stringbuffer_write(sb, "}", 1);
    } else if (ml_is(Val, MLAddressT)) {
        ml_stringbuffer_write(sb, "{\"type\":\"bytes\",\"value\":\"", 25);
        mlk_write_base64(sb, (const unsigned char *)ml_address_value(Val), (size_t)ml_address_length(Val));
        ml_stringbuffer_write(sb, "\"}", 2);
    } else {
        const char *tname = (ml_typeof(Val) && ml_typeof(Val)->Name) ? ml_typeof(Val)->Name : "any";
        ml_stringbuffer_t tmp[1] = {ML_STRINGBUFFER_INIT};
        ml_value_t *res = ml_stringbuffer_simple_append(tmp, Val);
        size_t len = 0;
        const char *s = "";
        if (!ml_is_error(res)) {
            len = tmp->Length;
            s = ml_stringbuffer_get_string(tmp);
            if (!s) { s = ""; len = 0; }
        }
        ml_stringbuffer_write(sb, "{\"type\":", 8);
        mlk_json_write_str(sb, tname, strlen(tname));
        ml_stringbuffer_write(sb, ",\"value\":", 9);
        mlk_json_write_str(sb, s, len);
        ml_stringbuffer_write(sb, "}", 1);
    }
}

void mlk_last_value_tagged_json(mlk_stdout_cb cb, void *ctx) {
    if (!cb) return;
    ml_stringbuffer_t sb[1] = {ML_STRINGBUFFER_INIT};
    mlk_write_tagged_json(sb, g_last_value ? g_last_value : MLNil, 0);
    size_t len = sb->Length;
    const char *s = ml_stringbuffer_get_string(sb);
    cb(s ? s : "{\"type\":\"nil\"}", s ? len : 14, ctx);
}
