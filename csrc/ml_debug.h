#ifndef ML_DEBUG_BRIDGE_H
#define ML_DEBUG_BRIDGE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*mld_stdout_cb)(const char *data, size_t len, void *ctx);
typedef void (*mld_display_cb)(const char *mime, const char *data, size_t len, void *ctx);
typedef void (*mld_result_cb)(const char *type_name, const char *repr, size_t repr_len, int is_nil, void *ctx);
typedef void (*mld_error_cb)(const char *err_type, const char *err_msg, const char *traceback, void *ctx);

typedef void (*mld_frame_cb)(int depth, const char *source, int line, void *ctx);
typedef void (*mld_local_cb)(const char *name, const char *type_name, const char *repr, int decl_line, int is_upvalue, void *ctx);

/* Status codes returned by ml_dbg_start / ml_dbg_resume */
#define ML_DBG_STATUS_IDLE      0
#define ML_DBG_STATUS_PAUSED    1
#define ML_DBG_STATUS_COMPLETED 2
#define ML_DBG_STATUS_ERROR     3

/* Resume action codes */
#define ML_DBG_ACTION_CONTINUE  0
#define ML_DBG_ACTION_STEP_IN   1
#define ML_DBG_ACTION_STEP_OVER 2
#define ML_DBG_ACTION_STEP_OUT  3

void ml_dbg_init(const char *exec_name, const char *ws_root);
void ml_dbg_set_breakpoints(const char *source, const int *lines, size_t count);
void ml_dbg_clear_all_breakpoints(void);
void ml_dbg_set_break_on_error(int enabled);

int ml_dbg_start(
    const char *source_name,
    const char *code,
    int stop_on_entry,
    int break_on_error,
    mld_stdout_cb stdout_cb,
    mld_display_cb display_cb,
    void *cb_ctx
);

int ml_dbg_resume(
    int action,
    mld_stdout_cb stdout_cb,
    mld_display_cb display_cb,
    void *cb_ctx
);

void ml_dbg_get_pause_info(
    char *reason_buf, size_t reason_cap,
    char *source_buf, size_t source_cap,
    int *line_out
);

void ml_dbg_get_final_result(
    char *type_buf, size_t type_cap,
    char *repr_buf, size_t repr_cap,
    int *is_nil_out
);

void ml_dbg_get_error(
    char *type_buf, size_t type_cap,
    char *msg_buf, size_t msg_cap,
    char *tb_buf, size_t tb_cap
);

void ml_dbg_frames(mld_frame_cb cb, void *ctx);
void ml_dbg_locals(int depth, mld_local_cb cb, void *ctx);

void ml_dbg_eval_in_frame(
    int depth,
    const char *expr,
    mld_stdout_cb stdout_cb,
    mld_display_cb display_cb,
    mld_result_cb result_cb,
    mld_error_cb error_cb,
    void *ctx
);

#ifdef __cplusplus
}
#endif

#endif /* ML_DEBUG_BRIDGE_H */
