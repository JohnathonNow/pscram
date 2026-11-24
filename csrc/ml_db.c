#include "ml_db.h"
#include "ml_macros.h"
#include "ml_types.h"
#include "ml_sequence.h"

#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* ============================================================================
 * Dynamically Loaded SQLite3 ABI (libsqlite3.so.0)
 * ============================================================================ */

#define ML_SQLITE_OK        0
#define ML_SQLITE_ROW     100
#define ML_SQLITE_DONE    101

#define ML_SQLITE_INTEGER   1
#define ML_SQLITE_FLOAT     2
#define ML_SQLITE_TEXT      3
#define ML_SQLITE_BLOB      4
#define ML_SQLITE_NULL      5

#define ML_SQLITE_OPEN_READONLY   0x00000001
#define ML_SQLITE_OPEN_READWRITE  0x00000002
#define ML_SQLITE_OPEN_CREATE     0x00000004
#define ML_SQLITE_OPEN_URI        0x00000040

#define ML_SQLITE_TRANSIENT ((void (*)(void *))-1)

typedef void ml_sqlite3;
typedef void ml_sqlite3_stmt;

typedef int (*fn_sqlite3_open_v2)(const char *filename, ml_sqlite3 **ppDb, int flags, const char *zVfs);
typedef int (*fn_sqlite3_close_v2)(ml_sqlite3 *db);
typedef const char *(*fn_sqlite3_errmsg)(ml_sqlite3 *db);
typedef int (*fn_sqlite3_busy_timeout)(ml_sqlite3 *db, int ms);
typedef int (*fn_sqlite3_exec)(ml_sqlite3 *db, const char *sql, int (*cb)(void *, int, char **, char **), void *arg, char **errmsg);
typedef void (*fn_sqlite3_free)(void *ptr);
typedef int (*fn_sqlite3_changes)(ml_sqlite3 *db);
typedef int64_t (*fn_sqlite3_last_insert_rowid)(ml_sqlite3 *db);
typedef int (*fn_sqlite3_prepare_v2)(ml_sqlite3 *db, const char *zSql, int nByte, ml_sqlite3_stmt **ppStmt, const char **pzTail);
typedef int (*fn_sqlite3_finalize)(ml_sqlite3_stmt *pStmt);
typedef int (*fn_sqlite3_step)(ml_sqlite3_stmt *pStmt);
typedef int (*fn_sqlite3_column_count)(ml_sqlite3_stmt *pStmt);
typedef const char *(*fn_sqlite3_column_name)(ml_sqlite3_stmt *pStmt, int N);
typedef int (*fn_sqlite3_column_type)(ml_sqlite3_stmt *pStmt, int iCol);
typedef int64_t (*fn_sqlite3_column_int64)(ml_sqlite3_stmt *pStmt, int iCol);
typedef double (*fn_sqlite3_column_double)(ml_sqlite3_stmt *pStmt, int iCol);
typedef const unsigned char *(*fn_sqlite3_column_text)(ml_sqlite3_stmt *pStmt, int iCol);
typedef const void *(*fn_sqlite3_column_blob)(ml_sqlite3_stmt *pStmt, int iCol);
typedef int (*fn_sqlite3_column_bytes)(ml_sqlite3_stmt *pStmt, int iCol);
typedef int (*fn_sqlite3_bind_null)(ml_sqlite3_stmt *pStmt, int idx);
typedef int (*fn_sqlite3_bind_int64)(ml_sqlite3_stmt *pStmt, int idx, int64_t val);
typedef int (*fn_sqlite3_bind_double)(ml_sqlite3_stmt *pStmt, int idx, double val);
typedef int (*fn_sqlite3_bind_text)(ml_sqlite3_stmt *pStmt, int idx, const char *val, int n, void (*destructor)(void *));
typedef int (*fn_sqlite3_bind_blob)(ml_sqlite3_stmt *pStmt, int idx, const void *val, int n, void (*destructor)(void *));
typedef int (*fn_sqlite3_bind_parameter_index)(ml_sqlite3_stmt *pStmt, const char *zName);

typedef struct {
    int loaded;
    void *handle;
    fn_sqlite3_open_v2 open_v2;
    fn_sqlite3_close_v2 close_v2;
    fn_sqlite3_errmsg errmsg;
    fn_sqlite3_busy_timeout busy_timeout;
    fn_sqlite3_exec exec;
    fn_sqlite3_free free_fn;
    fn_sqlite3_changes changes;
    fn_sqlite3_last_insert_rowid last_insert_rowid;
    fn_sqlite3_prepare_v2 prepare_v2;
    fn_sqlite3_finalize finalize;
    fn_sqlite3_step step;
    fn_sqlite3_column_count column_count;
    fn_sqlite3_column_name column_name;
    fn_sqlite3_column_type column_type;
    fn_sqlite3_column_int64 column_int64;
    fn_sqlite3_column_double column_double;
    fn_sqlite3_column_text column_text;
    fn_sqlite3_column_blob column_blob;
    fn_sqlite3_column_bytes column_bytes;
    fn_sqlite3_bind_null bind_null;
    fn_sqlite3_bind_int64 bind_int64;
    fn_sqlite3_bind_double bind_double;
    fn_sqlite3_bind_text bind_text;
    fn_sqlite3_bind_blob bind_blob;
    fn_sqlite3_bind_parameter_index bind_parameter_index;
} ml_sqlite_api_t;

static ml_sqlite_api_t g_sql = {0};

static int mldb_load_sqlite(char *ErrBuf, size_t ErrCap) {
    if (g_sql.loaded) return 0;
    void *H = dlopen("libsqlite3.so.0", RTLD_LAZY | RTLD_LOCAL);
    if (!H) H = dlopen("libsqlite3.so", RTLD_LAZY | RTLD_LOCAL);
    if (!H) {
        snprintf(ErrBuf, ErrCap, "Could not load libsqlite3.so.0: %s", dlerror());
        return -1;
    }

    g_sql.handle = H;
    g_sql.open_v2 = (fn_sqlite3_open_v2)dlsym(H, "sqlite3_open_v2");
    g_sql.close_v2 = (fn_sqlite3_close_v2)dlsym(H, "sqlite3_close_v2");
    g_sql.errmsg = (fn_sqlite3_errmsg)dlsym(H, "sqlite3_errmsg");
    g_sql.busy_timeout = (fn_sqlite3_busy_timeout)dlsym(H, "sqlite3_busy_timeout");
    g_sql.exec = (fn_sqlite3_exec)dlsym(H, "sqlite3_exec");
    g_sql.free_fn = (fn_sqlite3_free)dlsym(H, "sqlite3_free");
    g_sql.changes = (fn_sqlite3_changes)dlsym(H, "sqlite3_changes");
    g_sql.last_insert_rowid = (fn_sqlite3_last_insert_rowid)dlsym(H, "sqlite3_last_insert_rowid");
    g_sql.prepare_v2 = (fn_sqlite3_prepare_v2)dlsym(H, "sqlite3_prepare_v2");
    g_sql.finalize = (fn_sqlite3_finalize)dlsym(H, "sqlite3_finalize");
    g_sql.step = (fn_sqlite3_step)dlsym(H, "sqlite3_step");
    g_sql.column_count = (fn_sqlite3_column_count)dlsym(H, "sqlite3_column_count");
    g_sql.column_name = (fn_sqlite3_column_name)dlsym(H, "sqlite3_column_name");
    g_sql.column_type = (fn_sqlite3_column_type)dlsym(H, "sqlite3_column_type");
    g_sql.column_int64 = (fn_sqlite3_column_int64)dlsym(H, "sqlite3_column_int64");
    g_sql.column_double = (fn_sqlite3_column_double)dlsym(H, "sqlite3_column_double");
    g_sql.column_text = (fn_sqlite3_column_text)dlsym(H, "sqlite3_column_text");
    g_sql.column_blob = (fn_sqlite3_column_blob)dlsym(H, "sqlite3_column_blob");
    g_sql.column_bytes = (fn_sqlite3_column_bytes)dlsym(H, "sqlite3_column_bytes");
    g_sql.bind_null = (fn_sqlite3_bind_null)dlsym(H, "sqlite3_bind_null");
    g_sql.bind_int64 = (fn_sqlite3_bind_int64)dlsym(H, "sqlite3_bind_int64");
    g_sql.bind_double = (fn_sqlite3_bind_double)dlsym(H, "sqlite3_bind_double");
    g_sql.bind_text = (fn_sqlite3_bind_text)dlsym(H, "sqlite3_bind_text");
    g_sql.bind_blob = (fn_sqlite3_bind_blob)dlsym(H, "sqlite3_bind_blob");
    g_sql.bind_parameter_index = (fn_sqlite3_bind_parameter_index)dlsym(H, "sqlite3_bind_parameter_index");

    if (!g_sql.open_v2 || !g_sql.close_v2 || !g_sql.errmsg || !g_sql.exec ||
        !g_sql.prepare_v2 || !g_sql.finalize || !g_sql.step || !g_sql.column_count ||
        !g_sql.column_name || !g_sql.column_type || !g_sql.column_int64 ||
        !g_sql.column_double || !g_sql.column_text || !g_sql.column_blob ||
        !g_sql.column_bytes || !g_sql.bind_null || !g_sql.bind_int64 ||
        !g_sql.bind_double || !g_sql.bind_text || !g_sql.bind_blob ||
        !g_sql.bind_parameter_index) {
        dlclose(H);
        memset(&g_sql, 0, sizeof(g_sql));
        snprintf(ErrBuf, ErrCap, "Loaded libsqlite3 is missing required symbols");
        return -1;
    }

    g_sql.loaded = 1;
    return 0;
}

static int mldb_mkdir_p_parent(const char *Path) {
    if (!Path || !*Path || strcmp(Path, ":memory:") == 0) return 0;
    const char *Slash = strrchr(Path, '/');
    if (!Slash || Slash == Path) return 0;
    size_t DirLen = (size_t)(Slash - Path);
    char *Dir = (char *)malloc(DirLen + 1);
    if (!Dir) return -1;
    memcpy(Dir, Path, DirLen);
    Dir[DirLen] = '\0';

    for (char *P = Dir + 1; *P; ++P) {
        if (*P == '/') {
            *P = '\0';
            if (mkdir(Dir, 0755) != 0 && errno != EEXIST) {
                free(Dir);
                return -1;
            }
            *P = '/';
        }
    }
    if (mkdir(Dir, 0755) != 0 && errno != EEXIST) {
        free(Dir);
        return -1;
    }
    free(Dir);
    return 0;
}

/* ============================================================================
 * Connection Type: db::connection
 * ============================================================================ */

typedef struct {
    ml_type_t *Type;
    ml_sqlite3 *Handle;
    const char *Path;
    int ReadOnly;
    int Closed;
} ml_db_conn_t;

ML_TYPE(MLDbConnT, (), "db::connection");

static void mldb_finalize(ml_db_conn_t *Conn, void *Data) {
    (void)Data;
    if (Conn && Conn->Handle && g_sql.close_v2) {
        g_sql.close_v2(Conn->Handle);
        Conn->Handle = NULL;
        Conn->Closed = 1;
    }
}

static ml_value_t *mldb_bind_value(ml_sqlite3 *Db, ml_sqlite3_stmt *Stmt, int Idx, ml_value_t *Val) {
    Val = ml_deref(Val);
    int Rc = ML_SQLITE_OK;
    if (!Val || Val == MLNil) {
        Rc = g_sql.bind_null(Stmt, Idx);
    } else if (ml_is(Val, MLBooleanT)) {
        Rc = g_sql.bind_int64(Stmt, Idx, ml_boolean_value(Val) ? 1 : 0);
    } else if (ml_is(Val, MLIntegerT)) {
        Rc = g_sql.bind_int64(Stmt, Idx, ml_integer_value(Val));
    } else if (ml_is(Val, MLRealT)) {
        Rc = g_sql.bind_double(Stmt, Idx, ml_real_value(Val));
    } else if (ml_is(Val, MLStringT)) {
        Rc = g_sql.bind_text(Stmt, Idx, ml_string_value(Val), (int)ml_string_length(Val), ML_SQLITE_TRANSIENT);
    } else if (ml_is(Val, MLAddressT)) {
        Rc = g_sql.bind_blob(Stmt, Idx, ml_address_value(Val), (int)ml_address_length(Val), ML_SQLITE_TRANSIENT);
    } else {
        ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
        ml_value_t *Err = ml_stringbuffer_simple_append(Sb, Val);
        if (ml_is_error(Err)) return Err;
        size_t Len = Sb->Length;
        const char *S = ml_stringbuffer_get_string(Sb);
        Rc = g_sql.bind_text(Stmt, Idx, S ? S : "", (int)Len, ML_SQLITE_TRANSIENT);
    }
    if (Rc != ML_SQLITE_OK) {
        return ml_error("DbError", "SQLite bind error at parameter %d: %s", Idx, g_sql.errmsg(Db));
    }
    return NULL;
}

static ml_value_t *mldb_bind_params(ml_sqlite3 *Db, ml_sqlite3_stmt *Stmt, ml_value_t *Params) {
    if (!Params) return NULL;
    Params = ml_deref(Params);
    if (!Params || Params == MLNil) return NULL;

    if (ml_is(Params, MLListT)) {
        int Idx = 1;
        ML_LIST_FOREACH(Params, Node) {
            ml_value_t *Err = mldb_bind_value(Db, Stmt, Idx++, Node->Value);
            if (Err) return Err;
        }
        return NULL;
    }

    if (ml_is(Params, MLTupleT)) {
        int Size = ml_tuple_size(Params);
        for (int I = 1; I <= Size; ++I) {
            ml_value_t *Err = mldb_bind_value(Db, Stmt, I, ml_tuple_get(Params, I));
            if (Err) return Err;
        }
        return NULL;
    }

    if (ml_is(Params, MLMapT)) {
        ML_MAP_FOREACH(Params, Node) {
            ml_value_t *K = ml_deref(Node->Key);
            if (!ml_is(K, MLStringT)) {
                return ml_error("TypeError", "Named SQL parameter keys must be strings");
            }
            const char *Key = ml_string_value(K);
            int Idx = g_sql.bind_parameter_index(Stmt, Key);
            if (Idx == 0 && Key[0] != ':' && Key[0] != '@' && Key[0] != '$') {
                size_t Len = strlen(Key);
                char *Prefixed = (char *)malloc(Len + 2);
                if (!Prefixed) return ml_error("DbError", "Out of memory");
                Prefixed[0] = ':';
                memcpy(Prefixed + 1, Key, Len + 1);
                Idx = g_sql.bind_parameter_index(Stmt, Prefixed);
                if (Idx == 0) {
                    Prefixed[0] = '@';
                    Idx = g_sql.bind_parameter_index(Stmt, Prefixed);
                }
                if (Idx == 0) {
                    Prefixed[0] = '$';
                    Idx = g_sql.bind_parameter_index(Stmt, Prefixed);
                }
                free(Prefixed);
            }
            if (Idx > 0) {
                ml_value_t *Err = mldb_bind_value(Db, Stmt, Idx, Node->Value);
                if (Err) return Err;
            }
        }
        return NULL;
    }

    return ml_error("TypeError", "SQL parameters must be a list, tuple, map, or nil");
}

static ml_value_t *mldb_column_to_ml(ml_sqlite3_stmt *Stmt, int Col) {
    int Type = g_sql.column_type(Stmt, Col);
    switch (Type) {
        case ML_SQLITE_NULL:
            return MLNil;
        case ML_SQLITE_INTEGER:
            return ml_integer(g_sql.column_int64(Stmt, Col));
        case ML_SQLITE_FLOAT:
            return ml_real(g_sql.column_double(Stmt, Col));
        case ML_SQLITE_TEXT: {
            const unsigned char *Txt = g_sql.column_text(Stmt, Col);
            int Bytes = g_sql.column_bytes(Stmt, Col);
            if (!Txt || Bytes <= 0) return ml_string("", 0);
            return ml_string_copy((const char *)Txt, Bytes);
        }
        case ML_SQLITE_BLOB: {
            const void *Blob = g_sql.column_blob(Stmt, Col);
            int Bytes = g_sql.column_bytes(Stmt, Col);
            char *Copy = snew(Bytes > 0 ? (size_t)Bytes : 1);
            if (Bytes > 0 && Blob) memcpy(Copy, Blob, (size_t)Bytes);
            return ml_address(Copy, Bytes);
        }
        default:
            return MLNil;
    }
}

static ml_value_t *mldb_run_query(ml_sqlite3 *Db, const char *Sql, ml_value_t *Params, int SingleRow) {
    ml_sqlite3_stmt *Stmt = NULL;
    int Rc = g_sql.prepare_v2(Db, Sql, -1, &Stmt, NULL);
    if (Rc != ML_SQLITE_OK) {
        return ml_error("DbError", "SQLite prepare error: %s", g_sql.errmsg(Db));
    }

    ml_value_t *BindErr = mldb_bind_params(Db, Stmt, Params);
    if (BindErr) {
        g_sql.finalize(Stmt);
        return BindErr;
    }

    int ColCount = g_sql.column_count(Stmt);
    ml_value_t *Rows = SingleRow ? MLNil : ml_list();

    for (;;) {
        Rc = g_sql.step(Stmt);
        if (Rc == ML_SQLITE_ROW) {
            ml_value_t *Row = ml_map();
            for (int I = 0; I < ColCount; ++I) {
                const char *ColName = g_sql.column_name(Stmt, I);
                ml_value_t *K = ml_string_copy(ColName ? ColName : "", ColName ? (int)strlen(ColName) : 0);
                ml_value_t *V = mldb_column_to_ml(Stmt, I);
                ml_map_insert(Row, K, V);
            }
            if (SingleRow) {
                g_sql.finalize(Stmt);
                return Row;
            }
            ml_list_put(Rows, Row);
        } else if (Rc == ML_SQLITE_DONE) {
            break;
        } else {
            const char *Msg = g_sql.errmsg(Db);
            g_sql.finalize(Stmt);
            return ml_error("DbError", "SQLite step error: %s", Msg ? Msg : "unknown error");
        }
    }

    g_sql.finalize(Stmt);
    return Rows;
}

static ml_value_t *mldb_run_exec(ml_sqlite3 *Db, const char *Sql, ml_value_t *Params) {
    int HasParams = (Params != NULL && ml_deref(Params) != MLNil);
    if (!HasParams) {
        char *ErrMsg = NULL;
        int Rc = g_sql.exec(Db, Sql, NULL, NULL, &ErrMsg);
        if (Rc != ML_SQLITE_OK) {
            ml_value_t *Err = ml_error("DbError", "SQLite exec error: %s", ErrMsg ? ErrMsg : g_sql.errmsg(Db));
            if (ErrMsg && g_sql.free_fn) g_sql.free_fn(ErrMsg);
            return Err;
        }
    } else {
        ml_sqlite3_stmt *Stmt = NULL;
        int Rc = g_sql.prepare_v2(Db, Sql, -1, &Stmt, NULL);
        if (Rc != ML_SQLITE_OK) {
            return ml_error("DbError", "SQLite prepare error: %s", g_sql.errmsg(Db));
        }
        ml_value_t *BindErr = mldb_bind_params(Db, Stmt, Params);
        if (BindErr) {
            g_sql.finalize(Stmt);
            return BindErr;
        }
        for (;;) {
            Rc = g_sql.step(Stmt);
            if (Rc == ML_SQLITE_DONE) break;
            if (Rc != ML_SQLITE_ROW) {
                const char *Msg = g_sql.errmsg(Db);
                g_sql.finalize(Stmt);
                return ml_error("DbError", "SQLite exec step error: %s", Msg ? Msg : "unknown error");
            }
        }
        g_sql.finalize(Stmt);
    }

    ml_value_t *Res = ml_map();
    ml_map_insert(Res, ml_cstring("changes"), ml_integer(g_sql.changes ? g_sql.changes(Db) : 0));
    ml_map_insert(Res, ml_cstring("last_insert_rowid"), ml_integer(g_sql.last_insert_rowid ? g_sql.last_insert_rowid(Db) : 0));
    return Res;
}

static ml_value_t *mldb_open_internal(const char *Path, int ReadOnly, ml_sqlite3 **OutDb) {
    char ErrBuf[512];
    if (mldb_load_sqlite(ErrBuf, sizeof(ErrBuf)) != 0) {
        return ml_error("DbError", "%s", ErrBuf);
    }
    if (!ReadOnly) {
        if (mldb_mkdir_p_parent(Path) != 0) {
            return ml_error("DbError", "Failed to create parent directories for '%s': %s", Path, strerror(errno));
        }
    }
    int Flags = ReadOnly
        ? (ML_SQLITE_OPEN_READONLY | ML_SQLITE_OPEN_URI)
        : (ML_SQLITE_OPEN_READWRITE | ML_SQLITE_OPEN_CREATE | ML_SQLITE_OPEN_URI);
    ml_sqlite3 *Db = NULL;
    int Rc = g_sql.open_v2(Path, &Db, Flags, NULL);
    if (Rc != ML_SQLITE_OK || !Db) {
        const char *Msg = Db ? g_sql.errmsg(Db) : "failed to open sqlite database";
        ml_value_t *Err = ml_error("DbError", "Failed to open SQLite DB '%s': %s", Path, Msg ? Msg : "error");
        if (Db) g_sql.close_v2(Db);
        return Err;
    }
    if (g_sql.busy_timeout) {
        g_sql.busy_timeout(Db, 5000);
    }
    *OutDb = Db;
    return NULL;
}

/* ============================================================================
 * Module Functions & Methods
 * ============================================================================ */

ML_FUNCTION(MLDbOpen) {
    const char *Path = ":memory:";
    int ReadOnly = 0;
    if (Count >= 1 && ml_deref(Args[0]) != MLNil) {
        ML_CHECK_ARG_TYPE(0, MLStringT);
        Path = ml_string_value(Args[0]);
    }
    if (Count >= 2 && ml_deref(Args[1]) != MLNil) {
        ml_value_t *Opt = ml_deref(Args[1]);
        if (ml_is(Opt, MLStringT)) {
            const char *Mode = ml_string_value(Opt);
            if (strcmp(Mode, "r") == 0 || strcmp(Mode, "ro") == 0 || strcmp(Mode, "readonly") == 0) {
                ReadOnly = 1;
            }
        } else if (ml_is(Opt, MLBooleanT)) {
            ReadOnly = ml_boolean_value(Opt) ? 1 : 0;
        }
    }

    ml_sqlite3 *Db = NULL;
    ml_value_t *Err = mldb_open_internal(Path, ReadOnly, &Db);
    if (Err) return Err;

    ml_db_conn_t *Conn = new(ml_db_conn_t);
    Conn->Type = MLDbConnT;
    Conn->Handle = Db;
    size_t Plen = strlen(Path);
    char *Copy = snew(Plen + 1);
    memcpy(Copy, Path, Plen + 1);
    Conn->Path = Copy;
    Conn->ReadOnly = ReadOnly;
    Conn->Closed = 0;
    GC_register_finalizer(Conn, (void *)mldb_finalize, 0, 0, 0);
    return (ml_value_t *)Conn;
}

ML_FUNCTION(MLDbQuickQuery) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    ML_CHECK_ARG_TYPE(1, MLStringT);
    ml_sqlite3 *Db = NULL;
    ml_value_t *Err = mldb_open_internal(ml_string_value(Args[0]), 0, &Db);
    if (Err) return Err;
    ml_value_t *Params = Count >= 3 ? Args[2] : NULL;
    ml_value_t *Res = mldb_run_query(Db, ml_string_value(Args[1]), Params, 0);
    g_sql.close_v2(Db);
    return Res;
}

ML_FUNCTION(MLDbQuickExec) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    ML_CHECK_ARG_TYPE(1, MLStringT);
    ml_sqlite3 *Db = NULL;
    ml_value_t *Err = mldb_open_internal(ml_string_value(Args[0]), 0, &Db);
    if (Err) return Err;
    ml_value_t *Params = Count >= 3 ? Args[2] : NULL;
    ml_value_t *Res = mldb_run_exec(Db, ml_string_value(Args[1]), Params);
    g_sql.close_v2(Db);
    return Res;
}

static ml_value_t *mldb_method_query(void *Data, int Count, ml_value_t **Args) {
    int Single = (Data != NULL);
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    if (Conn->Closed || !Conn->Handle) return ml_error("DbError", "SQLite connection is closed");
    ml_value_t *Params = Count >= 3 ? Args[2] : NULL;
    return mldb_run_query(Conn->Handle, ml_string_value(Args[1]), Params, Single);
}

static ml_value_t *mldb_method_exec(void *Data, int Count, ml_value_t **Args) {
    (void)Data;
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    if (Conn->Closed || !Conn->Handle) return ml_error("DbError", "SQLite connection is closed");
    ml_value_t *Params = Count >= 3 ? Args[2] : NULL;
    return mldb_run_exec(Conn->Handle, ml_string_value(Args[1]), Params);
}

static ml_value_t *mldb_method_tables(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    if (Conn->Closed || !Conn->Handle) return ml_error("DbError", "SQLite connection is closed");
    ml_value_t *Rows = mldb_run_query(
        Conn->Handle,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        NULL,
        0
    );
    if (ml_is_error(Rows)) return Rows;
    ml_value_t *Names = ml_list();
    ML_LIST_FOREACH(Rows, Node) {
        ml_value_t *Name = ml_map_search(Node->Value, ml_cstring("name"));
        if (Name) ml_list_put(Names, Name);
    }
    return Names;
}

static ml_value_t *mldb_method_schema(void *Data, int Count, ml_value_t **Args) {
    (void)Data;
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    if (Conn->Closed || !Conn->Handle) return ml_error("DbError", "SQLite connection is closed");
    if (Count >= 2 && ml_is(ml_deref(Args[1]), MLStringT)) {
        ml_value_t *Params = ml_list();
        ml_list_put(Params, ml_deref(Args[1]));
        return mldb_run_query(
            Conn->Handle,
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ? OR tbl_name = ? ORDER BY type, name",
            Params,
            0
        );
    }
    return mldb_run_query(
        Conn->Handle,
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        NULL,
        0
    );
}

static ml_value_t *mldb_method_tx(void *Data, int Count, ml_value_t **Args) {
    (void)Count;
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    if (Conn->Closed || !Conn->Handle) return ml_error("DbError", "SQLite connection is closed");
    const char *Sql = (const char *)Data;
    ml_value_t *Res = mldb_run_exec(Conn->Handle, Sql, NULL);
    if (ml_is_error(Res)) return Res;
    return (ml_value_t *)Conn;
}

static ml_value_t *mldb_method_path(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    return ml_string(Conn->Path ? Conn->Path : ":memory:", -1);
}

static ml_value_t *mldb_method_close(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[0];
    if (Conn->Handle && g_sql.close_v2) {
        g_sql.close_v2(Conn->Handle);
        Conn->Handle = NULL;
    }
    Conn->Closed = 1;
    return MLNil;
}

static ml_value_t *mldb_method_sb_append(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_stringbuffer_t *Sb = (ml_stringbuffer_t *)Args[0];
    ml_db_conn_t *Conn = (ml_db_conn_t *)Args[1];
    ml_stringbuffer_printf(Sb, "<db \"%s\"%s>",
        Conn->Path ? Conn->Path : ":memory:",
        Conn->Closed ? " (closed)" : (Conn->ReadOnly ? " (ro)" : ""));
    return MLSome;
}

void ml_db_init(stringmap_t *Globals) {
    ml_type_init(MLDbConnT, NULL);

    ml_value_t *QueryFn = ml_cfunction(NULL, (ml_callback_t)mldb_method_query);
    ml_method_definev(ml_method("query"), QueryFn, NULL, MLDbConnT, MLStringT, NULL);
    ml_method_definev(ml_method("query"), QueryFn, NULL, MLDbConnT, MLStringT, MLAnyT, NULL);

    ml_value_t *OneFn = ml_cfunction((void *)1, (ml_callback_t)mldb_method_query);
    ml_method_definev(ml_method("one"), OneFn, NULL, MLDbConnT, MLStringT, NULL);
    ml_method_definev(ml_method("one"), OneFn, NULL, MLDbConnT, MLStringT, MLAnyT, NULL);

    ml_value_t *ExecFn = ml_cfunction(NULL, (ml_callback_t)mldb_method_exec);
    ml_method_definev(ml_method("exec"), ExecFn, NULL, MLDbConnT, MLStringT, NULL);
    ml_method_definev(ml_method("exec"), ExecFn, NULL, MLDbConnT, MLStringT, MLAnyT, NULL);

    ml_method_definev(ml_method("tables"), ml_cfunction(NULL, (ml_callback_t)mldb_method_tables), NULL, MLDbConnT, NULL);
    ml_value_t *SchemaFn = ml_cfunction(NULL, (ml_callback_t)mldb_method_schema);
    ml_method_definev(ml_method("schema"), SchemaFn, NULL, MLDbConnT, NULL);
    ml_method_definev(ml_method("schema"), SchemaFn, NULL, MLDbConnT, MLStringT, NULL);

    ml_method_definev(ml_method("begin"), ml_cfunction((void *)"BEGIN TRANSACTION", (ml_callback_t)mldb_method_tx), NULL, MLDbConnT, NULL);
    ml_method_definev(ml_method("commit"), ml_cfunction((void *)"COMMIT", (ml_callback_t)mldb_method_tx), NULL, MLDbConnT, NULL);
    ml_method_definev(ml_method("rollback"), ml_cfunction((void *)"ROLLBACK", (ml_callback_t)mldb_method_tx), NULL, MLDbConnT, NULL);
    ml_method_definev(ml_method("path"), ml_cfunction(NULL, (ml_callback_t)mldb_method_path), NULL, MLDbConnT, NULL);
    ml_method_definev(ml_method("close"), ml_cfunction(NULL, (ml_callback_t)mldb_method_close), NULL, MLDbConnT, NULL);

    ml_method_definev(
        ml_method("append"),
        ml_cfunction(NULL, (ml_callback_t)mldb_method_sb_append),
        NULL,
        MLStringBufferT,
        MLDbConnT,
        NULL
    );

    ml_value_t *DbMod = ml_module("db",
        "open", MLDbOpen,
        "query", MLDbQuickQuery,
        "exec", MLDbQuickExec,
        "connection", MLDbConnT,
        NULL
    );

    stringmap_insert(Globals, "db", DbMod);
    ml_externals_default_add("db", DbMod);
}
