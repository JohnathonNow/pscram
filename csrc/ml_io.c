#include "ml_io.h"
#include "ml_macros.h"
#include "ml_cbor.h"
#include "ml_json.h"
#include "ml_file.h"
#include "ml_types.h"

#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

/* ============================================================================
 * Helpers: Filesystem & Parent Directory Creation
 * ============================================================================ */

static int mlio_mkdir_p_parent(const char *Path) {
    if (!Path || !*Path) return 0;
    const char *LastSlash = strrchr(Path, '/');
    if (!LastSlash || LastSlash == Path) return 0;

    size_t DirLen = (size_t)(LastSlash - Path);
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

static unsigned char *mlio_read_entire_file(const char *Path, size_t *OutLen, char *ErrBuf, size_t ErrCap) {
    FILE *Fp = fopen(Path, "rb");
    if (!Fp) {
        snprintf(ErrBuf, ErrCap, "Failed to open '%s' for reading: %s", Path, strerror(errno));
        return NULL;
    }

    size_t Cap = 4096;
    size_t Len = 0;
    struct stat St;
    if (fstat(fileno(Fp), &St) == 0 && St.st_size > 0 && St.st_size < (off_t)(256 * 1024 * 1024)) {
        Cap = (size_t)St.st_size + 1;
    }

    unsigned char *Buf = (unsigned char *)malloc(Cap);
    if (!Buf) {
        fclose(Fp);
        snprintf(ErrBuf, ErrCap, "Out of memory reading '%s'", Path);
        return NULL;
    }

    for (;;) {
        if (Len + 4096 > Cap) {
            size_t NewCap = Cap * 2;
            unsigned char *Tmp = (unsigned char *)realloc(Buf, NewCap);
            if (!Tmp) {
                free(Buf);
                fclose(Fp);
                snprintf(ErrBuf, ErrCap, "Out of memory reading '%s'", Path);
                return NULL;
            }
            Buf = Tmp;
            Cap = NewCap;
        }
        size_t N = fread(Buf + Len, 1, Cap - Len, Fp);
        Len += N;
        if (N == 0) {
            if (ferror(Fp)) {
                snprintf(ErrBuf, ErrCap, "Error reading '%s': %s", Path, strerror(errno));
                free(Buf);
                fclose(Fp);
                return NULL;
            }
            break;
        }
    }

    fclose(Fp);
    *OutLen = Len;
    return Buf;
}

static unsigned long g_tmp_seq = 0;

static int mlio_write_atomic(const char *Path, const void *Data, size_t Len, char *ErrBuf, size_t ErrCap) {
    if (mlio_mkdir_p_parent(Path) != 0) {
        snprintf(ErrBuf, ErrCap, "Failed to create parent directories for '%s': %s", Path, strerror(errno));
        return -1;
    }

    size_t PathLen = strlen(Path);
    char *TmpPath = (char *)malloc(PathLen + 64);
    if (!TmpPath) {
        snprintf(ErrBuf, ErrCap, "Out of memory");
        return -1;
    }
    snprintf(TmpPath, PathLen + 64, "%s.tmp.%ld.%lu", Path, (long)getpid(), ++g_tmp_seq);

    FILE *Fp = fopen(TmpPath, "wb");
    if (!Fp) {
        free(TmpPath);
        /* Fallback to direct write (e.g., special files) */
        Fp = fopen(Path, "wb");
        if (!Fp) {
            snprintf(ErrBuf, ErrCap, "Failed to open '%s' for writing: %s", Path, strerror(errno));
            return -1;
        }
        if (Len > 0 && fwrite(Data, 1, Len, Fp) != Len) {
            snprintf(ErrBuf, ErrCap, "Failed to write '%s': %s", Path, strerror(errno));
            fclose(Fp);
            return -1;
        }
        if (fclose(Fp) != 0) {
            snprintf(ErrBuf, ErrCap, "Failed to close '%s': %s", Path, strerror(errno));
            return -1;
        }
        return 0;
    }

    if (Len > 0 && fwrite(Data, 1, Len, Fp) != Len) {
        snprintf(ErrBuf, ErrCap, "Failed to write temporary file for '%s': %s", Path, strerror(errno));
        fclose(Fp);
        unlink(TmpPath);
        free(TmpPath);
        return -1;
    }
    if (fflush(Fp) != 0 || fclose(Fp) != 0) {
        snprintf(ErrBuf, ErrCap, "Failed to flush '%s': %s", Path, strerror(errno));
        unlink(TmpPath);
        free(TmpPath);
        return -1;
    }

    if (rename(TmpPath, Path) != 0) {
        snprintf(ErrBuf, ErrCap, "Failed to replace '%s': %s", Path, strerror(errno));
        unlink(TmpPath);
        free(TmpPath);
        return -1;
    }

    free(TmpPath);
    return 0;
}

/* ============================================================================
 * Module 1: store (CBOR, raw bytes, and string file persistence)
 *   store::get(Path)              / store::put(Path, Value)       / store::create(Path, Fn)
 *   store::get_raw(Path)          / store::put_raw(Path, Bytes)   / store::create_raw(Path, Fn)
 *   store::get_bytes(Path)        / store::put_bytes(Path, Bytes) / store::create_bytes(Path, Fn)
 *   store::get_string(Path)       / store::put_string(Path, Str)  / store::create_string(Path, Fn)
 *   store::get_text(Path)         / store::put_text(Path, Str)    / store::create_text(Path, Fn)
 *   store::exists(Path)           / store::delete(Path)
 * ============================================================================ */

typedef enum {
    ML_STORE_CBOR = 0,
    ML_STORE_RAW = 1,
    ML_STORE_STRING = 2,
} ml_store_mode_t;

static ml_value_t *mlio_store_read_cbor(const char *Path) {
    size_t Len = 0;
    char ErrBuf[512];
    unsigned char *Raw = mlio_read_entire_file(Path, &Len, ErrBuf, sizeof(ErrBuf));
    if (!Raw) {
        return ml_error("StoreError", "%s", ErrBuf);
    }
    if (Len == 0) {
        free(Raw);
        return ml_error("StoreError", "Store file '%s' is empty", Path);
    }

    /* Copy into GC memory before decoding because ml_from_cbor may keep slices/strings */
    char *GcBuf = snew(Len);
    memcpy(GcBuf, Raw, Len);
    free(Raw);

    ml_cbor_t Cbor = {{.Data = GcBuf}, Len};
    return ml_from_cbor(Cbor, NULL, NULL);
}

static ml_value_t *mlio_store_read_raw(const char *Path) {
    size_t Len = 0;
    char ErrBuf[512];
    unsigned char *Raw = mlio_read_entire_file(Path, &Len, ErrBuf, sizeof(ErrBuf));
    if (!Raw) {
        return ml_error("StoreError", "%s", ErrBuf);
    }
    char *GcBuf = snew(Len > 0 ? Len : 1);
    if (Len > 0) memcpy(GcBuf, Raw, Len);
    free(Raw);
    return ml_address(GcBuf, (int)Len);
}

static ml_value_t *mlio_store_read_string(const char *Path) {
    size_t Len = 0;
    char ErrBuf[512];
    unsigned char *Raw = mlio_read_entire_file(Path, &Len, ErrBuf, sizeof(ErrBuf));
    if (!Raw) {
        return ml_error("StoreError", "%s", ErrBuf);
    }
    ml_value_t *Val = (Len > 0) ? ml_string_copy((const char *)Raw, (int)Len) : ml_string("", 0);
    free(Raw);
    return Val;
}

static ml_value_t *mlio_store_read(const char *Path, ml_store_mode_t Mode) {
    switch (Mode) {
        case ML_STORE_RAW: return mlio_store_read_raw(Path);
        case ML_STORE_STRING: return mlio_store_read_string(Path);
        case ML_STORE_CBOR:
        default: return mlio_store_read_cbor(Path);
    }
}

static ml_value_t *mlio_store_write_cbor(const char *Path, ml_value_t *Value) {
    ml_value_t *Deref = ml_deref(Value);
    ml_cbor_t Cbor = ml_cbor_encode(Deref);
    if (!Cbor.Length) {
        return Cbor.Error ? Cbor.Error : ml_error("CBORError", "Failed to encode value to CBOR");
    }
    if (!Cbor.Data) {
        return ml_error("CBORError", "Failed to encode value to CBOR");
    }

    char ErrBuf[512];
    if (mlio_write_atomic(Path, Cbor.Data, Cbor.Length, ErrBuf, sizeof(ErrBuf)) != 0) {
        return ml_error("StoreError", "%s", ErrBuf);
    }
    return Deref;
}

static ml_value_t *mlio_store_write_raw(const char *Path, ml_value_t *Value) {
    ml_value_t *Deref = ml_deref(Value);
    const void *Data = NULL;
    size_t Len = 0;

    if (ml_is(Deref, MLAddressT)) {
        Data = ml_address_value(Deref);
        Len = (size_t)ml_address_length(Deref);
    } else if (ml_is(Deref, MLStringT)) {
        Data = ml_string_value(Deref);
        Len = ml_string_length(Deref);
    } else {
        return ml_error("TypeError", "store::put_raw expects an address/buffer or string, got %s",
            ml_typeof(Deref)->Name);
    }

    char ErrBuf[512];
    if (mlio_write_atomic(Path, Data ? Data : "", Len, ErrBuf, sizeof(ErrBuf)) != 0) {
        return ml_error("StoreError", "%s", ErrBuf);
    }
    return Deref;
}

static ml_value_t *mlio_store_write_string(const char *Path, ml_value_t *Value) {
    ml_value_t *Deref = ml_deref(Value);
    const char *Str = NULL;
    size_t Len = 0;

    if (ml_is(Deref, MLStringT)) {
        Str = ml_string_value(Deref);
        Len = ml_string_length(Deref);
    } else {
        ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
        ml_value_t *Res = ml_stringbuffer_simple_append(Sb, Deref);
        if (ml_is_error(Res)) return Res;
        Len = Sb->Length;
        Str = ml_stringbuffer_get_string(Sb);
    }

    char ErrBuf[512];
    if (mlio_write_atomic(Path, Str ? Str : "", Len, ErrBuf, sizeof(ErrBuf)) != 0) {
        return ml_error("StoreError", "%s", ErrBuf);
    }
    return Deref;
}

static ml_value_t *mlio_store_write(const char *Path, ml_value_t *Value, ml_store_mode_t Mode) {
    switch (Mode) {
        case ML_STORE_RAW: return mlio_store_write_raw(Path, Value);
        case ML_STORE_STRING: return mlio_store_write_string(Path, Value);
        case ML_STORE_CBOR:
        default: return mlio_store_write_cbor(Path, Value);
    }
}

ML_FUNCTION(MLStoreGet) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    return mlio_store_read(ml_string_value(Args[0]), ML_STORE_CBOR);
}

ML_FUNCTION(MLStorePut) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    return mlio_store_write(ml_string_value(Args[0]), Args[1], ML_STORE_CBOR);
}

ML_FUNCTION(MLStoreGetRaw) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    return mlio_store_read(ml_string_value(Args[0]), ML_STORE_RAW);
}

ML_FUNCTION(MLStorePutRaw) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    return mlio_store_write(ml_string_value(Args[0]), Args[1], ML_STORE_RAW);
}

ML_FUNCTION(MLStoreGetString) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    return mlio_store_read(ml_string_value(Args[0]), ML_STORE_STRING);
}

ML_FUNCTION(MLStorePutString) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    return mlio_store_write(ml_string_value(Args[0]), Args[1], ML_STORE_STRING);
}

typedef struct {
    ml_state_t Base;
    const char *Path;
    ml_store_mode_t Mode;
} ml_store_create_state_t;

static void ml_store_create_run(ml_store_create_state_t *State, ml_value_t *Value) {
    ml_state_t *Caller = State->Base.Caller;
    Value = ml_deref(Value);
    if (ml_is_error(Value)) {
        ML_RETURN(Value);
    }
    ml_value_t *Written = mlio_store_write(State->Path, Value, State->Mode);
    ML_RETURN(Written);
}

static void mlio_store_create_impl(ml_state_t *Caller, int Count, ml_value_t **Args, ml_store_mode_t Mode) {
    ML_CHECKX_ARG_COUNT(2);
    ML_CHECKX_ARG_TYPE(0, MLStringT);
    ml_value_t *PathVal = ml_deref(Args[0]);
    ml_value_t *Fn = ml_deref(Args[1]);
    const char *Path = ml_string_value(PathVal);

    struct stat St;
    if (stat(Path, &St) == 0 && S_ISREG(St.st_mode)) {
        ML_RETURN(mlio_store_read(Path, Mode));
    }

    ml_store_create_state_t *State = new(ml_store_create_state_t);
    State->Base.Type = MLStateT;
    State->Base.Caller = Caller;
    State->Base.Context = Caller->Context;
    State->Base.run = (ml_state_fn)ml_store_create_run;
    State->Path = Path;
    State->Mode = Mode;

    ml_value_t **CallArgs = ml_alloc_args(1);
    CallArgs[0] = PathVal;
    return ml_call((ml_state_t *)State, Fn, 1, CallArgs);
}

ML_FUNCTIONX(MLStoreCreate) {
    mlio_store_create_impl(Caller, Count, Args, ML_STORE_CBOR);
}

ML_FUNCTIONX(MLStoreCreateRaw) {
    mlio_store_create_impl(Caller, Count, Args, ML_STORE_RAW);
}

ML_FUNCTIONX(MLStoreCreateString) {
    mlio_store_create_impl(Caller, Count, Args, ML_STORE_STRING);
}

ML_FUNCTION(MLStoreExists) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    const char *Path = ml_string_value(Args[0]);
    struct stat St;
    if (stat(Path, &St) == 0 && S_ISREG(St.st_mode)) {
        return Args[0];
    }
    return MLNil;
}

ML_FUNCTION(MLStoreDelete) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    const char *Path = ml_string_value(Args[0]);
    if (unlink(Path) == 0) {
        return ml_boolean(1);
    }
    if (errno == ENOENT) {
        return MLNil;
    }
    return ml_error("StoreError", "Failed to delete '%s': %s", Path, strerror(errno));
}

/* ============================================================================
 * Module 2: http (via dynamically loaded libcurl.so.4)
 *   http::get(URL, Mode, QueryParams, Headers)
 *   http::post(URL, Mode, QueryParams, Headers, Body)
 *   http::put(URL, Mode, QueryParams, Headers, Body)
 *   http::patch(URL, Mode, QueryParams, Headers, Body)
 *   http::delete(URL, Mode, QueryParams, Headers, Body)
 *   http::request(Method, URL, Mode, QueryParams, Headers, Body)
 * ============================================================================ */

/* Standard stable libcurl ABI constants */
#define ML_CURL_GLOBAL_DEFAULT     3L
#define ML_CURLE_OK                0

#define ML_CURLOPT_WRITEDATA          10001
#define ML_CURLOPT_URL                10002
#define ML_CURLOPT_TIMEOUT               13
#define ML_CURLOPT_POSTFIELDS         10015
#define ML_CURLOPT_USERAGENT          10018
#define ML_CURLOPT_HTTPHEADER         10023
#define ML_CURLOPT_HEADERDATA         10029
#define ML_CURLOPT_CUSTOMREQUEST      10036
#define ML_CURLOPT_POST                  47
#define ML_CURLOPT_FOLLOWLOCATION        52
#define ML_CURLOPT_CONNECTTIMEOUT        78
#define ML_CURLOPT_NOSIGNAL              99
#define ML_CURLOPT_WRITEFUNCTION      20011
#define ML_CURLOPT_HEADERFUNCTION     20079
#define ML_CURLOPT_POSTFIELDSIZE_LARGE 30120

#define ML_CURLINFO_RESPONSE_CODE  0x200002

typedef void ML_CURL;
struct ml_curl_slist {
    char *data;
    struct ml_curl_slist *next;
};

typedef int (*fn_curl_global_init)(long flags);
typedef ML_CURL *(*fn_curl_easy_init)(void);
typedef int (*fn_curl_easy_setopt)(ML_CURL *curl, int option, ...);
typedef int (*fn_curl_easy_perform)(ML_CURL *curl);
typedef int (*fn_curl_easy_getinfo)(ML_CURL *curl, int info, ...);
typedef void (*fn_curl_easy_cleanup)(ML_CURL *curl);
typedef const char *(*fn_curl_easy_strerror)(int code);
typedef struct ml_curl_slist *(*fn_curl_slist_append)(struct ml_curl_slist *list, const char *str);
typedef void (*fn_curl_slist_free_all)(struct ml_curl_slist *list);

typedef struct {
    int loaded;
    void *handle;
    fn_curl_global_init global_init;
    fn_curl_easy_init easy_init;
    fn_curl_easy_setopt easy_setopt;
    fn_curl_easy_perform easy_perform;
    fn_curl_easy_getinfo easy_getinfo;
    fn_curl_easy_cleanup easy_cleanup;
    fn_curl_easy_strerror easy_strerror;
    fn_curl_slist_append slist_append;
    fn_curl_slist_free_all slist_free_all;
} ml_curl_api_t;

static ml_curl_api_t g_curl = {0};

static int mlio_load_curl(char *ErrBuf, size_t ErrCap) {
    if (g_curl.loaded) return 0;

    void *H = dlopen("libcurl.so.4", RTLD_LAZY | RTLD_LOCAL);
    if (!H) H = dlopen("libcurl.so", RTLD_LAZY | RTLD_LOCAL);
    if (!H) {
        snprintf(ErrBuf, ErrCap, "Could not load libcurl.so.4: %s", dlerror());
        return -1;
    }

    g_curl.handle = H;
    g_curl.global_init = (fn_curl_global_init)dlsym(H, "curl_global_init");
    g_curl.easy_init = (fn_curl_easy_init)dlsym(H, "curl_easy_init");
    g_curl.easy_setopt = (fn_curl_easy_setopt)dlsym(H, "curl_easy_setopt");
    g_curl.easy_perform = (fn_curl_easy_perform)dlsym(H, "curl_easy_perform");
    g_curl.easy_getinfo = (fn_curl_easy_getinfo)dlsym(H, "curl_easy_getinfo");
    g_curl.easy_cleanup = (fn_curl_easy_cleanup)dlsym(H, "curl_easy_cleanup");
    g_curl.easy_strerror = (fn_curl_easy_strerror)dlsym(H, "curl_easy_strerror");
    g_curl.slist_append = (fn_curl_slist_append)dlsym(H, "curl_slist_append");
    g_curl.slist_free_all = (fn_curl_slist_free_all)dlsym(H, "curl_slist_free_all");

    if (!g_curl.easy_init || !g_curl.easy_setopt || !g_curl.easy_perform ||
        !g_curl.easy_getinfo || !g_curl.easy_cleanup || !g_curl.easy_strerror ||
        !g_curl.slist_append || !g_curl.slist_free_all) {
        dlclose(H);
        memset(&g_curl, 0, sizeof(g_curl));
        snprintf(ErrBuf, ErrCap, "Loaded libcurl is missing required symbols");
        return -1;
    }

    if (g_curl.global_init) {
        g_curl.global_init(ML_CURL_GLOBAL_DEFAULT);
    }
    g_curl.loaded = 1;
    return 0;
}

typedef struct {
    unsigned char *Data;
    size_t Len;
    size_t Cap;
    FILE *File;
    int Failed;
} ml_http_sink_t;

static size_t mlio_curl_write_cb(char *Ptr, size_t Size, size_t Nmemb, void *Userdata) {
    ml_http_sink_t *Sink = (ml_http_sink_t *)Userdata;
    size_t Total = Size * Nmemb;
    if (Total == 0) return 0;

    if (Sink->File) {
        size_t Written = fwrite(Ptr, 1, Total, Sink->File);
        if (Written != Total) {
            Sink->Failed = 1;
            return 0;
        }
        Sink->Len += Written;
        return Written;
    }

    if (Sink->Len + Total + 1 > Sink->Cap) {
        size_t NewCap = Sink->Cap ? Sink->Cap * 2 : 4096;
        while (NewCap < Sink->Len + Total + 1) NewCap *= 2;
        unsigned char *Tmp = (unsigned char *)realloc(Sink->Data, NewCap);
        if (!Tmp) {
            Sink->Failed = 1;
            return 0;
        }
        Sink->Data = Tmp;
        Sink->Cap = NewCap;
    }
    memcpy(Sink->Data + Sink->Len, Ptr, Total);
    Sink->Len += Total;
    Sink->Data[Sink->Len] = '\0';
    return Total;
}

typedef struct {
    char *Data;
    size_t Len;
    size_t Cap;
} ml_http_hdr_buf_t;

static size_t mlio_curl_header_cb(char *Ptr, size_t Size, size_t Nmemb, void *Userdata) {
    ml_http_hdr_buf_t *Buf = (ml_http_hdr_buf_t *)Userdata;
    size_t Total = Size * Nmemb;
    if (Total == 0) return 0;
    if (Buf->Len + Total + 1 > Buf->Cap) {
        size_t NewCap = Buf->Cap ? Buf->Cap * 2 : 1024;
        while (NewCap < Buf->Len + Total + 1) NewCap *= 2;
        char *Tmp = (char *)realloc(Buf->Data, NewCap);
        if (!Tmp) return 0;
        Buf->Data = Tmp;
        Buf->Cap = NewCap;
    }
    memcpy(Buf->Data + Buf->Len, Ptr, Total);
    Buf->Len += Total;
    Buf->Data[Buf->Len] = '\0';
    return Total;
}

static void mlio_url_encode_append(ml_stringbuffer_t *Sb, const char *Str, size_t Len) {
    static const char Hex[] = "0123456789ABCDEF";
    for (size_t I = 0; I < Len; ++I) {
        unsigned char C = (unsigned char)Str[I];
        if ((C >= 'A' && C <= 'Z') || (C >= 'a' && C <= 'z') ||
            (C >= '0' && C <= '9') || C == '-' || C == '_' || C == '.' || C == '~') {
            ml_stringbuffer_put(Sb, (char)C);
        } else {
            char Esc[3] = {'%', Hex[(C >> 4) & 0xF], Hex[C & 0xF]};
            ml_stringbuffer_write(Sb, Esc, 3);
        }
    }
}

static ml_value_t *mlio_value_to_str(ml_value_t *Val, const char **OutStr, size_t *OutLen) {
    Val = ml_deref(Val);
    if (ml_is(Val, MLStringT)) {
        *OutStr = ml_string_value(Val);
        *OutLen = ml_string_length(Val);
        return NULL;
    }
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Err = ml_stringbuffer_simple_append(Sb, Val);
    if (ml_is_error(Err)) return Err;
    *OutLen = Sb->Length;
    const char *S = ml_stringbuffer_get_string(Sb);
    *OutStr = S ? S : "";
    return NULL;
}

static ml_value_t *mlio_build_url(const char *BaseUrl, size_t BaseLen, ml_value_t *Query, char **OutUrl) {
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_write(Sb, BaseUrl, BaseLen);

    if (Query && Query != MLNil) {
        Query = ml_deref(Query);
        if (ml_is(Query, MLStringT)) {
            const char *Qs = ml_string_value(Query);
            size_t Qlen = ml_string_length(Query);
            if (Qlen > 0 && Qs[0] == '?') { Qs++; Qlen--; }
            if (Qlen > 0) {
                ml_stringbuffer_put(Sb, memchr(BaseUrl, '?', BaseLen) ? '&' : '?');
                ml_stringbuffer_write(Sb, Qs, Qlen);
            }
        } else if (ml_is(Query, MLMapT)) {
            int HasQ = memchr(BaseUrl, '?', BaseLen) != NULL;
            ML_MAP_FOREACH(Query, Node) {
                ml_value_t *K = ml_deref(Node->Key);
                ml_value_t *V = ml_deref(Node->Value);
                if (!V || V == MLNil) continue;
                const char *Ks = NULL;
                size_t Klen = 0;
                ml_value_t *Err = mlio_value_to_str(K, &Ks, &Klen);
                if (Err) return Err;

                if (ml_is(V, MLListT)) {
                    ML_LIST_FOREACH(V, Item) {
                        ml_value_t *Iv = ml_deref(Item->Value);
                        if (!Iv || Iv == MLNil) continue;
                        const char *Vs = NULL;
                        size_t Vlen = 0;
                        Err = mlio_value_to_str(Iv, &Vs, &Vlen);
                        if (Err) return Err;
                        ml_stringbuffer_put(Sb, HasQ ? '&' : '?');
                        HasQ = 1;
                        mlio_url_encode_append(Sb, Ks, Klen);
                        ml_stringbuffer_put(Sb, '=');
                        mlio_url_encode_append(Sb, Vs, Vlen);
                    }
                } else {
                    const char *Vs = NULL;
                    size_t Vlen = 0;
                    Err = mlio_value_to_str(V, &Vs, &Vlen);
                    if (Err) return Err;
                    ml_stringbuffer_put(Sb, HasQ ? '&' : '?');
                    HasQ = 1;
                    mlio_url_encode_append(Sb, Ks, Klen);
                    ml_stringbuffer_put(Sb, '=');
                    mlio_url_encode_append(Sb, Vs, Vlen);
                }
            }
        } else {
            return ml_error("TypeError", "HTTP query params must be a map, string, or nil");
        }
    }

    size_t FinalLen = Sb->Length;
    const char *FinalStr = ml_stringbuffer_get_string(Sb);
    char *Copy = (char *)malloc(FinalLen + 1);
    if (!Copy) return ml_error("HttpError", "Out of memory building URL");
    if (FinalLen > 0 && FinalStr) memcpy(Copy, FinalStr, FinalLen);
    Copy[FinalLen] = '\0';
    *OutUrl = Copy;
    return NULL;
}

static ml_value_t *mlio_build_headers(
    ml_value_t *HeadersVal,
    struct ml_curl_slist **OutList,
    int *HasContentType,
    int *HasExpect
) {
    *OutList = NULL;
    *HasContentType = 0;
    *HasExpect = 0;
    if (!HeadersVal || HeadersVal == MLNil) return NULL;
    HeadersVal = ml_deref(HeadersVal);
    if (!HeadersVal || HeadersVal == MLNil) return NULL;

    if (ml_is(HeadersVal, MLMapT)) {
        ML_MAP_FOREACH(HeadersVal, Node) {
            const char *Ks = NULL, *Vs = NULL;
            size_t Klen = 0, Vlen = 0;
            ml_value_t *Err = mlio_value_to_str(Node->Key, &Ks, &Klen);
            if (Err) {
                if (*OutList) g_curl.slist_free_all(*OutList);
                *OutList = NULL;
                return Err;
            }
            ml_value_t *V = ml_deref(Node->Value);
            if (!V || V == MLNil) continue;
            Err = mlio_value_to_str(V, &Vs, &Vlen);
            if (Err) {
                if (*OutList) g_curl.slist_free_all(*OutList);
                *OutList = NULL;
                return Err;
            }
            if (Klen == 12 && strncasecmp(Ks, "Content-Type", 12) == 0) *HasContentType = 1;
            if (Klen == 6 && strncasecmp(Ks, "Expect", 6) == 0) *HasExpect = 1;

            char *Line = (char *)malloc(Klen + Vlen + 3);
            if (!Line) {
                if (*OutList) g_curl.slist_free_all(*OutList);
                *OutList = NULL;
                return ml_error("HttpError", "Out of memory building headers");
            }
            memcpy(Line, Ks, Klen);
            Line[Klen] = ':';
            Line[Klen + 1] = ' ';
            memcpy(Line + Klen + 2, Vs, Vlen);
            Line[Klen + Vlen + 2] = '\0';
            *OutList = g_curl.slist_append(*OutList, Line);
            free(Line);
        }
        return NULL;
    }

    if (ml_is(HeadersVal, MLListT)) {
        ML_LIST_FOREACH(HeadersVal, Node) {
            const char *Ls = NULL;
            size_t Llen = 0;
            ml_value_t *Err = mlio_value_to_str(Node->Value, &Ls, &Llen);
            if (Err) {
                if (*OutList) g_curl.slist_free_all(*OutList);
                *OutList = NULL;
                return Err;
            }
            if (Llen >= 13 && strncasecmp(Ls, "Content-Type:", 13) == 0) *HasContentType = 1;
            if (Llen >= 7 && strncasecmp(Ls, "Expect:", 7) == 0) *HasExpect = 1;
            char *Copy = (char *)malloc(Llen + 1);
            if (!Copy) {
                if (*OutList) g_curl.slist_free_all(*OutList);
                *OutList = NULL;
                return ml_error("HttpError", "Out of memory building headers");
            }
            memcpy(Copy, Ls, Llen);
            Copy[Llen] = '\0';
            *OutList = g_curl.slist_append(*OutList, Copy);
            free(Copy);
        }
        return NULL;
    }

    return ml_error("TypeError", "HTTP headers must be a map, list, or nil");
}

static ml_value_t *mlio_serialize_body(
    ml_value_t *BodyVal,
    char **OutBuf,
    size_t *OutLen,
    const char **DefaultContentType
) {
    *OutBuf = NULL;
    *OutLen = 0;
    *DefaultContentType = NULL;
    if (!BodyVal || BodyVal == MLNil) return NULL;
    BodyVal = ml_deref(BodyVal);
    if (!BodyVal || BodyVal == MLNil) return NULL;

    if (ml_is(BodyVal, MLStringT)) {
        const char *S = ml_string_value(BodyVal);
        size_t L = ml_string_length(BodyVal);
        char *Copy = (char *)malloc(L + 1);
        if (!Copy) return ml_error("HttpError", "Out of memory copying body");
        if (L > 0) memcpy(Copy, S, L);
        Copy[L] = '\0';
        *OutBuf = Copy;
        *OutLen = L;
        *DefaultContentType = "text/plain; charset=utf-8";
        return NULL;
    }

    if (ml_is(BodyVal, MLAddressT)) {
        const char *P = ml_address_value(BodyVal);
        size_t L = (size_t)ml_address_length(BodyVal);
        char *Copy = (char *)malloc(L + 1);
        if (!Copy) return ml_error("HttpError", "Out of memory copying raw body");
        if (L > 0 && P) memcpy(Copy, P, L);
        Copy[L] = '\0';
        *OutBuf = Copy;
        *OutLen = L;
        *DefaultContentType = "application/octet-stream";
        return NULL;
    }

    if (ml_is(BodyVal, MLFileT)) {
        FILE *Fp = ml_file_handle(BodyVal);
        if (!Fp) return ml_error("FileError", "Cannot send closed file as HTTP body");
        size_t Cap = 4096, Len = 0;
        char *Buf = (char *)malloc(Cap);
        if (!Buf) return ml_error("HttpError", "Out of memory reading file body");
        for (;;) {
            if (Len + 4096 > Cap) {
                Cap *= 2;
                char *Tmp = (char *)realloc(Buf, Cap);
                if (!Tmp) { free(Buf); return ml_error("HttpError", "Out of memory reading file body"); }
                Buf = Tmp;
            }
            size_t N = fread(Buf + Len, 1, Cap - Len, Fp);
            Len += N;
            if (N == 0) break;
        }
        Buf[Len] = '\0';
        *OutBuf = Buf;
        *OutLen = Len;
        *DefaultContentType = "application/octet-stream";
        return NULL;
    }

    /* Structured Minilang values (map, list, integer, real, boolean, etc.) -> JSON */
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Err = ml_json_encode(Sb, BodyVal);
    if (Err) return Err;
    size_t L = Sb->Length;
    const char *S = ml_stringbuffer_get_string(Sb);
    char *Copy = (char *)malloc(L + 1);
    if (!Copy) return ml_error("HttpError", "Out of memory copying JSON body");
    if (L > 0 && S) memcpy(Copy, S, L);
    Copy[L] = '\0';
    *OutBuf = Copy;
    *OutLen = L;
    *DefaultContentType = "application/json";
    return NULL;
}

static ml_value_t *mlio_parse_response_headers(const char *Raw, size_t Len) {
    ml_value_t *Map = ml_map();
    if (!Raw || Len == 0) return Map;

    /* Find the start of the final response header block (after redirects) */
    const char *Start = Raw;
    const char *End = Raw + Len;
    const char *P = Raw;
    while (P < End) {
        const char *Nl = (const char *)memchr(P, '\n', (size_t)(End - P));
        const char *LineEnd = Nl ? Nl : End;
        if ((size_t)(LineEnd - P) >= 5 && strncasecmp(P, "HTTP/", 5) == 0) {
            Start = P;
        }
        P = Nl ? (Nl + 1) : End;
    }

    P = Start;
    while (P < End) {
        const char *Nl = (const char *)memchr(P, '\n', (size_t)(End - P));
        const char *LineEnd = Nl ? Nl : End;
        const char *TrimEnd = LineEnd;
        while (TrimEnd > P && (TrimEnd[-1] == '\r' || TrimEnd[-1] == ' ' || TrimEnd[-1] == '\t')) {
            TrimEnd--;
        }
        const char *Colon = (const char *)memchr(P, ':', (size_t)(TrimEnd - P));
        if (Colon && Colon > P) {
            size_t Klen = (size_t)(Colon - P);
            char *LowerKey = snew(Klen + 1);
            for (size_t I = 0; I < Klen; ++I) {
                LowerKey[I] = (char)tolower((unsigned char)P[I]);
            }
            LowerKey[Klen] = '\0';

            const char *Vstart = Colon + 1;
            while (Vstart < TrimEnd && (*Vstart == ' ' || *Vstart == '\t')) Vstart++;
            size_t Vlen = (size_t)(TrimEnd - Vstart);
            ml_map_insert(Map, ml_string_copy(LowerKey, (int)Klen), ml_string_copy(Vstart, (int)Vlen));
        }
        P = Nl ? (Nl + 1) : End;
    }
    return Map;
}

static ml_value_t *mlio_http_exec(
    const char *Method,
    int HasBodyParam,
    int Count,
    ml_value_t **Args
) {
    /* Extract optional trailing named args (MLNamesT) */
    ml_value_t *NamedMode = NULL;
    ml_value_t *NamedQuery = NULL;
    ml_value_t *NamedHeaders = NULL;
    ml_value_t *NamedBody = NULL;
    ml_value_t *NamedFilePath = NULL;
    long TimeoutSecs = 30;
    int PosCount = Count;

    for (int I = 0; I < Count; ++I) {
        ml_value_t *Arg = ml_deref(Args[I]);
        if (ml_is(Arg, MLNamesT)) {
            PosCount = I;
            int Pos = I + 1;
            ML_NAMES_FOREACH(Arg, Node) {
                if (Pos >= Count) break;
                const char *Key = ml_string_value(Node->Value);
                ml_value_t *Val = ml_deref(Args[Pos++]);
                if (strcmp(Key, "mode") == 0 || strcmp(Key, "as") == 0) {
                    NamedMode = Val;
                } else if (strcmp(Key, "query") == 0 || strcmp(Key, "params") == 0) {
                    NamedQuery = Val;
                } else if (strcmp(Key, "headers") == 0) {
                    NamedHeaders = Val;
                } else if (strcmp(Key, "body") == 0 || strcmp(Key, "data") == 0 || strcmp(Key, "json") == 0) {
                    NamedBody = Val;
                } else if (strcmp(Key, "file") == 0 || strcmp(Key, "path") == 0 || strcmp(Key, "dest") == 0) {
                    NamedFilePath = Val;
                } else if (strcmp(Key, "timeout") == 0 && ml_is(Val, MLIntegerT)) {
                    TimeoutSecs = (long)ml_integer_value(Val);
                    if (TimeoutSecs < 1) TimeoutSecs = 1;
                }
            }
            break;
        }
    }

    if (PosCount < 1) {
        return ml_error("CallError", "http::%s requires at least 1 argument (URL)", Method);
    }
    ml_value_t *UrlVal = ml_deref(Args[0]);
    if (!ml_is(UrlVal, MLStringT)) {
        return ml_error("TypeError", "HTTP URL must be a string");
    }

    ml_value_t *ModeVal = (PosCount >= 2 && ml_deref(Args[1]) != MLNil) ? ml_deref(Args[1]) : NamedMode;
    ml_value_t *QueryVal = (PosCount >= 3 && ml_deref(Args[2]) != MLNil) ? ml_deref(Args[2]) : NamedQuery;
    ml_value_t *HeadersVal = (PosCount >= 4 && ml_deref(Args[3]) != MLNil) ? ml_deref(Args[3]) : NamedHeaders;
    ml_value_t *BodyVal = NULL;
    if (HasBodyParam) {
        BodyVal = (PosCount >= 5 && ml_deref(Args[4]) != MLNil) ? ml_deref(Args[4]) : NamedBody;
    } else if (NamedBody) {
        BodyVal = NamedBody;
    }

    const char *Mode = "text";
    if (ModeVal && ModeVal != MLNil) {
        if (!ml_is(ModeVal, MLStringT)) {
            return ml_error("TypeError", "HTTP response mode must be a string (\"json\", \"text\", \"raw\", \"file\", or \"response\")");
        }
        Mode = ml_string_value(ModeVal);
    }

    int IsJson = (strcmp(Mode, "json") == 0);
    int IsText = (strcmp(Mode, "text") == 0);
    int IsRaw = (strcmp(Mode, "raw") == 0);
    int IsFile = (strcmp(Mode, "file") == 0);
    int IsResponse = (strcmp(Mode, "response") == 0);
    if (!IsJson && !IsText && !IsRaw && !IsFile && !IsResponse) {
        return ml_error("ValueError", "Unknown HTTP response mode '%s' (expected \"json\", \"text\", \"raw\", \"file\", or \"response\")", Mode);
    }

    char ErrBuf[512];
    if (mlio_load_curl(ErrBuf, sizeof(ErrBuf)) != 0) {
        return ml_error("HttpError", "%s", ErrBuf);
    }

    char *FullUrl = NULL;
    ml_value_t *Err = mlio_build_url(ml_string_value(UrlVal), ml_string_length(UrlVal), QueryVal, &FullUrl);
    if (Err) return Err;

    struct ml_curl_slist *CurlHeaders = NULL;
    int HasContentType = 0;
    int HasExpect = 0;
    Err = mlio_build_headers(HeadersVal, &CurlHeaders, &HasContentType, &HasExpect);
    if (Err) {
        free(FullUrl);
        return Err;
    }

    char *BodyBuf = NULL;
    size_t BodyLen = 0;
    const char *DefaultCT = NULL;
    if (HasBodyParam || BodyVal != NULL) {
        Err = mlio_serialize_body(BodyVal, &BodyBuf, &BodyLen, &DefaultCT);
        if (Err) {
            free(FullUrl);
            if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
            return Err;
        }
        if (DefaultCT && !HasContentType) {
            char CtHdr[128];
            snprintf(CtHdr, sizeof(CtHdr), "Content-Type: %s", DefaultCT);
            CurlHeaders = g_curl.slist_append(CurlHeaders, CtHdr);
        }
        if (!HasExpect) {
            CurlHeaders = g_curl.slist_append(CurlHeaders, "Expect:");
        }
    }

    FILE *OutFile = NULL;
    if (IsFile) {
        if (NamedFilePath && NamedFilePath != MLNil) {
            if (!ml_is(NamedFilePath, MLStringT)) {
                free(FullUrl);
                free(BodyBuf);
                if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
                return ml_error("TypeError", "HTTP file destination path must be a string");
            }
            const char *DestPath = ml_string_value(NamedFilePath);
            if (mlio_mkdir_p_parent(DestPath) != 0) {
                free(FullUrl);
                free(BodyBuf);
                if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
                return ml_error("FileError", "Failed to create parent directories for '%s': %s", DestPath, strerror(errno));
            }
            OutFile = fopen(DestPath, "w+b");
            if (!OutFile) {
                free(FullUrl);
                free(BodyBuf);
                if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
                return ml_error("FileError", "Failed to open '%s': %s", DestPath, strerror(errno));
            }
        } else {
            OutFile = tmpfile();
            if (!OutFile) {
                free(FullUrl);
                free(BodyBuf);
                if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
                return ml_error("FileError", "Failed to create temporary file: %s", strerror(errno));
            }
        }
    }

    ML_CURL *Curl = g_curl.easy_init();
    if (!Curl) {
        free(FullUrl);
        free(BodyBuf);
        if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
        if (OutFile) fclose(OutFile);
        return ml_error("HttpError", "curl_easy_init failed");
    }

    ml_http_sink_t Sink = {NULL, 0, 0, OutFile, 0};
    ml_http_hdr_buf_t RespHdrs = {NULL, 0, 0};

    g_curl.easy_setopt(Curl, ML_CURLOPT_URL, FullUrl);
    g_curl.easy_setopt(Curl, ML_CURLOPT_FOLLOWLOCATION, 1L);
    g_curl.easy_setopt(Curl, ML_CURLOPT_NOSIGNAL, 1L);
    g_curl.easy_setopt(Curl, ML_CURLOPT_CONNECTTIMEOUT, 15L);
    g_curl.easy_setopt(Curl, ML_CURLOPT_TIMEOUT, TimeoutSecs);
    g_curl.easy_setopt(Curl, ML_CURLOPT_USERAGENT, "minilang-notebook/0.1");
    g_curl.easy_setopt(Curl, ML_CURLOPT_WRITEFUNCTION, mlio_curl_write_cb);
    g_curl.easy_setopt(Curl, ML_CURLOPT_WRITEDATA, &Sink);

    if (IsResponse) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_HEADERFUNCTION, mlio_curl_header_cb);
        g_curl.easy_setopt(Curl, ML_CURLOPT_HEADERDATA, &RespHdrs);
    }

    if (CurlHeaders) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_HTTPHEADER, CurlHeaders);
    }

    if (strcmp(Method, "POST") == 0) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_POST, 1L);
        g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDS, BodyBuf ? BodyBuf : "");
        g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDSIZE_LARGE, (int64_t)BodyLen);
    } else if (strcmp(Method, "GET") != 0) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_CUSTOMREQUEST, Method);
        if (BodyBuf != NULL || strcmp(Method, "PUT") == 0 || strcmp(Method, "PATCH") == 0) {
            g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDS, BodyBuf ? BodyBuf : "");
            g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDSIZE_LARGE, (int64_t)BodyLen);
        }
    }

    int Res = g_curl.easy_perform(Curl);
    long StatusCode = 0;
    if (Res == ML_CURLE_OK) {
        g_curl.easy_getinfo(Curl, ML_CURLINFO_RESPONSE_CODE, &StatusCode);
    }
    const char *CurlErrStr = (Res != ML_CURLE_OK) ? g_curl.easy_strerror(Res) : NULL;

    g_curl.easy_cleanup(Curl);
    if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);
    free(BodyBuf);
    free(FullUrl);

    if (Res != ML_CURLE_OK || Sink.Failed) {
        free(Sink.Data);
        free(RespHdrs.Data);
        if (OutFile) fclose(OutFile);
        return ml_error("HttpError", "HTTP %s failed: %s", Method, CurlErrStr ? CurlErrStr : "write error");
    }

    if (IsResponse) {
        ml_value_t *Map = ml_map();
        ml_map_insert(Map, ml_cstring("status"), ml_integer(StatusCode));
        ml_map_insert(Map, ml_cstring("headers"), mlio_parse_response_headers(RespHdrs.Data, RespHdrs.Len));
        ml_value_t *BodyStr = (Sink.Data && Sink.Len > 0)
            ? ml_string_copy((const char *)Sink.Data, (int)Sink.Len)
            : ml_string("", 0);
        ml_map_insert(Map, ml_cstring("body"), BodyStr);
        free(Sink.Data);
        free(RespHdrs.Data);
        return Map;
    }

    free(RespHdrs.Data);

    if (StatusCode >= 400) {
        char Snippet[256];
        if (OutFile) {
            fflush(OutFile);
            rewind(OutFile);
            size_t N = fread(Snippet, 1, sizeof(Snippet) - 1, OutFile);
            Snippet[N] = '\0';
            fclose(OutFile);
        } else if (Sink.Data && Sink.Len > 0) {
            size_t N = Sink.Len < sizeof(Snippet) - 1 ? Sink.Len : sizeof(Snippet) - 1;
            memcpy(Snippet, Sink.Data, N);
            Snippet[N] = '\0';
        } else {
            Snippet[0] = '\0';
        }
        free(Sink.Data);
        if (Snippet[0] != '\0') {
            return ml_error("HttpError", "HTTP %ld: %s", StatusCode, Snippet);
        }
        return ml_error("HttpError", "HTTP request returned status %ld", StatusCode);
    }

    if (IsFile) {
        fflush(OutFile);
        rewind(OutFile);
        return ml_file(OutFile);
    }

    if (IsRaw) {
        char *Copy = snew(Sink.Len > 0 ? Sink.Len : 1);
        if (Sink.Len > 0 && Sink.Data) memcpy(Copy, Sink.Data, Sink.Len);
        size_t Len = Sink.Len;
        free(Sink.Data);
        return ml_address(Copy, (int)Len);
    }

    if (IsText) {
        ml_value_t *Val = (Sink.Data && Sink.Len > 0)
            ? ml_string_copy((const char *)Sink.Data, (int)Sink.Len)
            : ml_string("", 0);
        free(Sink.Data);
        return Val;
    }

    /* IsJson */
    ml_value_t *Decoded = ml_json_decode(
        Sink.Data ? (const char *)Sink.Data : "",
        Sink.Len
    );
    free(Sink.Data);
    return Decoded;
}

ML_FUNCTION(MLHttpGet) {
    return mlio_http_exec("GET", 0, Count, Args);
}

ML_FUNCTION(MLHttpPost) {
    return mlio_http_exec("POST", 1, Count, Args);
}

ML_FUNCTION(MLHttpPut) {
    return mlio_http_exec("PUT", 1, Count, Args);
}

ML_FUNCTION(MLHttpPatch) {
    return mlio_http_exec("PATCH", 1, Count, Args);
}

ML_FUNCTION(MLHttpDelete) {
    return mlio_http_exec("DELETE", 1, Count, Args);
}

ML_FUNCTION(MLHttpRequest) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    const char *MethodRaw = ml_string_value(Args[0]);
    char Method[32];
    size_t Len = strlen(MethodRaw);
    if (Len == 0 || Len >= sizeof(Method)) {
        return ml_error("ValueError", "Invalid HTTP method '%s'", MethodRaw);
    }
    for (size_t I = 0; I < Len; ++I) {
        Method[I] = (char)toupper((unsigned char)MethodRaw[I]);
    }
    Method[Len] = '\0';
    int HasBody = (strcmp(Method, "GET") != 0 && strcmp(Method, "HEAD") != 0);
    return mlio_http_exec(Method, HasBody, Count - 1, Args + 1);
}

/* ============================================================================
 * Shared JSON HTTP Helper (for internal C modules such as `ml_ai.c`)
 * ============================================================================ */

ml_value_t *mlio_http_json_raw(
    const char *Method,
    const char *Url,
    const char *const *ExtraHeaders,
    const char *JsonBody,
    size_t BodyLen,
    long TimeoutSecs,
    long *OutStatus
) {
    if (OutStatus) *OutStatus = 0;
    char ErrBuf[512];
    if (mlio_load_curl(ErrBuf, sizeof(ErrBuf)) != 0) {
        return ml_error("HttpError", "%s", ErrBuf);
    }

    ML_CURL *Curl = g_curl.easy_init();
    if (!Curl) {
        return ml_error("HttpError", "curl_easy_init failed");
    }

    struct ml_curl_slist *CurlHeaders = NULL;
    int HasContentType = 0;
    if (ExtraHeaders) {
        for (int I = 0; ExtraHeaders[I]; ++I) {
            if (strncasecmp(ExtraHeaders[I], "Content-Type:", 13) == 0) {
                HasContentType = 1;
            }
            CurlHeaders = g_curl.slist_append(CurlHeaders, ExtraHeaders[I]);
        }
    }
    if (JsonBody && !HasContentType) {
        CurlHeaders = g_curl.slist_append(CurlHeaders, "Content-Type: application/json");
    }
    CurlHeaders = g_curl.slist_append(CurlHeaders, "Expect:");

    ml_http_sink_t Sink = {NULL, 0, 0, NULL, 0};
    long EffTimeout = (TimeoutSecs > 0) ? TimeoutSecs : 60L;

    g_curl.easy_setopt(Curl, ML_CURLOPT_URL, Url);
    g_curl.easy_setopt(Curl, ML_CURLOPT_FOLLOWLOCATION, 1L);
    g_curl.easy_setopt(Curl, ML_CURLOPT_NOSIGNAL, 1L);
    g_curl.easy_setopt(Curl, ML_CURLOPT_CONNECTTIMEOUT, 15L);
    g_curl.easy_setopt(Curl, ML_CURLOPT_TIMEOUT, EffTimeout);
    g_curl.easy_setopt(Curl, ML_CURLOPT_USERAGENT, "minilang-notebook/0.1");
    g_curl.easy_setopt(Curl, ML_CURLOPT_WRITEFUNCTION, mlio_curl_write_cb);
    g_curl.easy_setopt(Curl, ML_CURLOPT_WRITEDATA, &Sink);
    if (CurlHeaders) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_HTTPHEADER, CurlHeaders);
    }

    if (strcmp(Method, "POST") == 0) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_POST, 1L);
        g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDS, JsonBody ? JsonBody : "");
        g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDSIZE_LARGE, (int64_t)(JsonBody ? BodyLen : 0));
    } else if (strcmp(Method, "GET") != 0) {
        g_curl.easy_setopt(Curl, ML_CURLOPT_CUSTOMREQUEST, Method);
        if (JsonBody) {
            g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDS, JsonBody);
            g_curl.easy_setopt(Curl, ML_CURLOPT_POSTFIELDSIZE_LARGE, (int64_t)BodyLen);
        }
    }

    int Res = g_curl.easy_perform(Curl);
    long StatusCode = 0;
    if (Res == ML_CURLE_OK) {
        g_curl.easy_getinfo(Curl, ML_CURLINFO_RESPONSE_CODE, &StatusCode);
    }
    const char *CurlErrStr = (Res != ML_CURLE_OK) ? g_curl.easy_strerror(Res) : NULL;

    g_curl.easy_cleanup(Curl);
    if (CurlHeaders) g_curl.slist_free_all(CurlHeaders);

    if (OutStatus) *OutStatus = StatusCode;

    if (Res != ML_CURLE_OK || Sink.Failed) {
        free(Sink.Data);
        return ml_error("HttpError", "HTTP %s failed: %s", Method, CurlErrStr ? CurlErrStr : "write error");
    }

    if (!OutStatus && StatusCode >= 400) {
        char Snippet[512];
        if (Sink.Data && Sink.Len > 0) {
            size_t N = Sink.Len < sizeof(Snippet) - 1 ? Sink.Len : sizeof(Snippet) - 1;
            memcpy(Snippet, Sink.Data, N);
            Snippet[N] = '\0';
        } else {
            Snippet[0] = '\0';
        }
        free(Sink.Data);
        if (Snippet[0] != '\0') {
            return ml_error("HttpError", "HTTP %ld: %s", StatusCode, Snippet);
        }
        return ml_error("HttpError", "HTTP request returned status %ld", StatusCode);
    }

    ml_value_t *Decoded = ml_json_decode(
        Sink.Data ? (const char *)Sink.Data : "{}",
        Sink.Data ? Sink.Len : 2
    );
    if (ml_is_error(Decoded)) {
        ml_value_t *Fallback = ml_map();
        ml_value_t *RawStr = (Sink.Data && Sink.Len > 0)
            ? ml_string_copy((const char *)Sink.Data, (int)Sink.Len)
            : ml_string("", 0);
        ml_map_insert(Fallback, ml_cstring("raw_text"), RawStr);
        free(Sink.Data);
        return Fallback;
    }
    free(Sink.Data);
    return Decoded;
}

/* ============================================================================
 * Module Registration
 * ============================================================================ */

void ml_io_init(stringmap_t *Globals) {
    ml_value_t *StoreMod = ml_module("store",
        "get", MLStoreGet,
        "put", MLStorePut,
        "create", MLStoreCreate,
        "get_raw", MLStoreGetRaw,
        "put_raw", MLStorePutRaw,
        "create_raw", MLStoreCreateRaw,
        "get_bytes", MLStoreGetRaw,
        "put_bytes", MLStorePutRaw,
        "create_bytes", MLStoreCreateRaw,
        "get_string", MLStoreGetString,
        "put_string", MLStorePutString,
        "create_string", MLStoreCreateString,
        "get_text", MLStoreGetString,
        "put_text", MLStorePutString,
        "create_text", MLStoreCreateString,
        "exists", MLStoreExists,
        "delete", MLStoreDelete,
        NULL
    );

    ml_value_t *HttpMod = ml_module("http",
        "get", MLHttpGet,
        "post", MLHttpPost,
        "put", MLHttpPut,
        "patch", MLHttpPatch,
        "delete", MLHttpDelete,
        "request", MLHttpRequest,
        NULL
    );

    stringmap_insert(Globals, "store", StoreMod);
    stringmap_insert(Globals, "http", HttpMod);

    ml_externals_default_add("store", StoreMod);
    ml_externals_default_add("http", HttpMod);
}
