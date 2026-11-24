#include "ml_jobs.h"
#include "ml_macros.h"
#include "ml_json.h"
#include "ml_types.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

/* ============================================================================
 * Minimal Localhost HTTP/1.1 JSON Client (zero external deps, uses internal token)
 * ============================================================================ */

static int mljobs_parse_internal_url(char *HostBuf, size_t HostCap, int *OutPort) {
    const char *Url = getenv("MINILANG_INTERNAL_URL");
    if (!Url || !*Url) return -1;
    const char *P = Url;
    if (strncmp(P, "http://", 7) == 0) P += 7;
    const char *Slash = strchr(P, '/');
    size_t HostPortLen = Slash ? (size_t)(Slash - P) : strlen(P);
    if (HostPortLen == 0 || HostPortLen >= HostCap) return -1;

    char Tmp[256];
    if (HostPortLen >= sizeof(Tmp)) return -1;
    memcpy(Tmp, P, HostPortLen);
    Tmp[HostPortLen] = '\0';

    char *Colon = strrchr(Tmp, ':');
    if (Colon) {
        *Colon = '\0';
        *OutPort = atoi(Colon + 1);
    } else {
        *OutPort = 80;
    }
    if (Tmp[0] == '\0' || strcmp(Tmp, "0.0.0.0") == 0) {
        snprintf(HostBuf, HostCap, "127.0.0.1");
    } else {
        snprintf(HostBuf, HostCap, "%s", Tmp);
    }
    return (*OutPort > 0 && *OutPort <= 65535) ? 0 : -1;
}

static char *mljobs_decode_chunked(const char *Src, size_t SrcLen, size_t *OutLen) {
    char *Out = (char *)malloc(SrcLen + 1);
    if (!Out) return NULL;
    size_t Pos = 0;
    size_t Written = 0;
    while (Pos < SrcLen) {
        const char *CrLf = strstr(Src + Pos, "\r\n");
        if (!CrLf) break;
        size_t LineLen = (size_t)(CrLf - (Src + Pos));
        char HexBuf[32];
        if (LineLen >= sizeof(HexBuf)) LineLen = sizeof(HexBuf) - 1;
        memcpy(HexBuf, Src + Pos, LineLen);
        HexBuf[LineLen] = '\0';
        size_t ChunkLen = (size_t)strtoull(HexBuf, NULL, 16);
        Pos = (size_t)(CrLf - Src) + 2;
        if (ChunkLen == 0) break;
        if (Pos + ChunkLen > SrcLen) ChunkLen = SrcLen - Pos;
        memcpy(Out + Written, Src + Pos, ChunkLen);
        Written += ChunkLen;
        Pos += ChunkLen;
        if (Pos + 2 <= SrcLen && Src[Pos] == '\r' && Src[Pos + 1] == '\n') Pos += 2;
    }
    Out[Written] = '\0';
    *OutLen = Written;
    return Out;
}

static ml_value_t *mljobs_http_json(
    const char *Method,
    const char *Path,
    const char *JsonBody,
    size_t BodyLen,
    int *OutStatus
) {
    char Host[128];
    int Port = 0;
    if (mljobs_parse_internal_url(Host, sizeof(Host), &Port) != 0) {
        return ml_error("JobError", "Background jobs API is unavailable (MINILANG_INTERNAL_URL not set)");
    }

    int Sock = socket(AF_INET, SOCK_STREAM, 0);
    if (Sock < 0) {
        return ml_error("JobError", "Failed to create socket: %s", strerror(errno));
    }

    struct sockaddr_in Addr;
    memset(&Addr, 0, sizeof(Addr));
    Addr.sin_family = AF_INET;
    Addr.sin_port = htons((uint16_t)Port);
    if (inet_pton(AF_INET, Host, &Addr.sin_addr) != 1) {
        struct hostent *He = gethostbyname(Host);
        if (!He || !He->h_addr_list || !He->h_addr_list[0]) {
            close(Sock);
            return ml_error("JobError", "Could not resolve internal server host '%s'", Host);
        }
        memcpy(&Addr.sin_addr, He->h_addr_list[0], sizeof(Addr.sin_addr));
    }

    if (connect(Sock, (struct sockaddr *)&Addr, sizeof(Addr)) != 0) {
        int Err = errno;
        close(Sock);
        return ml_error("JobError", "Failed to connect to job server %s:%d: %s", Host, Port, strerror(Err));
    }

    const char *Token = getenv("MINILANG_INTERNAL_TOKEN");
    char HeaderBuf[1024];
    int HdrLen = snprintf(
        HeaderBuf,
        sizeof(HeaderBuf),
        "%s %s HTTP/1.1\r\n"
        "Host: %s:%d\r\n"
        "Connection: close\r\n"
        "%s%s%s"
        "Content-Type: application/json\r\n"
        "Content-Length: %zu\r\n"
        "\r\n",
        Method,
        Path,
        Host,
        Port,
        (Token && *Token) ? "X-Internal-Token: " : "",
        (Token && *Token) ? Token : "",
        (Token && *Token) ? "\r\n" : "",
        JsonBody ? BodyLen : (size_t)0
    );

    size_t Sent = 0;
    while (Sent < (size_t)HdrLen) {
        ssize_t N = send(Sock, HeaderBuf + Sent, (size_t)HdrLen - Sent, 0);
        if (N <= 0) {
            close(Sock);
            return ml_error("JobError", "Failed sending request headers to job server");
        }
        Sent += (size_t)N;
    }

    if (JsonBody && BodyLen > 0) {
        Sent = 0;
        while (Sent < BodyLen) {
            ssize_t N = send(Sock, JsonBody + Sent, BodyLen - Sent, 0);
            if (N <= 0) {
                close(Sock);
                return ml_error("JobError", "Failed sending request body to job server");
            }
            Sent += (size_t)N;
        }
    }

    size_t Cap = 4096;
    size_t Len = 0;
    char *Buf = (char *)malloc(Cap);
    if (!Buf) {
        close(Sock);
        return ml_error("JobError", "Out of memory reading job response");
    }

    for (;;) {
        if (Len + 2048 >= Cap) {
            Cap *= 2;
            char *Tmp = (char *)realloc(Buf, Cap);
            if (!Tmp) {
                free(Buf);
                close(Sock);
                return ml_error("JobError", "Out of memory growing job response buffer");
            }
            Buf = Tmp;
        }
        ssize_t N = recv(Sock, Buf + Len, Cap - Len - 1, 0);
        if (N < 0) {
            if (errno == EINTR) continue;
            free(Buf);
            close(Sock);
            return ml_error("JobError", "Error reading response from job server: %s", strerror(errno));
        }
        if (N == 0) break;
        Len += (size_t)N;
    }
    Buf[Len] = '\0';
    close(Sock);

    char *Sep = strstr(Buf, "\r\n\r\n");
    if (!Sep) {
        free(Buf);
        return ml_error("JobError", "Malformed HTTP response from job server");
    }

    int Status = 0;
    const char *Sp = strchr(Buf, ' ');
    if (Sp) Status = atoi(Sp + 1);
    if (OutStatus) *OutStatus = Status;

    *Sep = '\0';
    int IsChunked = (strstr(Buf, "transfer-encoding: chunked") != NULL ||
                     strstr(Buf, "Transfer-Encoding: chunked") != NULL);
    const char *BodyPtr = Sep + 4;
    size_t RespBodyLen = Len - (size_t)(BodyPtr - Buf);

    char *ChunkedOut = NULL;
    if (IsChunked) {
        ChunkedOut = mljobs_decode_chunked(BodyPtr, RespBodyLen, &RespBodyLen);
        if (ChunkedOut) BodyPtr = ChunkedOut;
    }

    ml_value_t *Decoded = ml_json_decode(BodyPtr, RespBodyLen);
    free(ChunkedOut);
    free(Buf);

    if (Status >= 400) {
        if (Decoded && ml_is(Decoded, MLMapT)) {
            ml_value_t *ErrVal = ml_map_search(Decoded, ml_cstring("error"));
            if (ErrVal && ml_is(ErrVal, MLStringT)) {
                return ml_error("JobError", "%s", ml_string_value(ErrVal));
            }
        }
        return ml_error("JobError", "Job server returned HTTP %d", Status);
    }

    return Decoded ? Decoded : MLNil;
}

static ml_value_t *mljobs_to_json_safe(ml_value_t *Val) {
    Val = ml_deref(Val);
    if (!Val || Val == MLNil) return MLNil;
    if (ml_is(Val, MLBooleanT) || ml_is(Val, MLIntegerT) || ml_is(Val, MLRealT) || ml_is(Val, MLStringT)) {
        return Val;
    }
    if (ml_is(Val, MLListT)) {
        ml_value_t *Out = ml_list();
        ML_LIST_FOREACH(Val, Node) {
            ml_list_put(Out, mljobs_to_json_safe(Node->Value));
        }
        return Out;
    }
    if (ml_is(Val, MLTupleT)) {
        ml_value_t *Out = ml_list();
        int N = ml_tuple_size(Val);
        for (int I = 1; I <= N; ++I) {
            ml_list_put(Out, mljobs_to_json_safe(ml_tuple_get(Val, I)));
        }
        return Out;
    }
    if (ml_is(Val, MLMapT)) {
        ml_value_t *Out = ml_map();
        ML_MAP_FOREACH(Val, Node) {
            ml_value_t *K = ml_deref(Node->Key);
            ml_value_t *KStr = K;
            if (!ml_is(K, MLStringT)) {
                ml_stringbuffer_t KSb[1] = {ML_STRINGBUFFER_INIT};
                ml_stringbuffer_simple_append(KSb, K);
                size_t KLen = KSb->Length;
                const char *S = ml_stringbuffer_get_string(KSb);
                KStr = ml_string_copy(S ? S : "", (int)KLen);
            }
            ml_map_insert(Out, KStr, mljobs_to_json_safe(Node->Value));
        }
        return Out;
    }
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_simple_append(Sb, Val);
    size_t Len = Sb->Length;
    const char *S = ml_stringbuffer_get_string(Sb);
    return ml_string_copy(S ? S : "", (int)Len);
}

/* ============================================================================
 * Job Handle Type: jobs::handle
 * ============================================================================ */

typedef struct {
    ml_type_t *Type;
    const char *Id;
    const char *Script;
} ml_job_handle_t;

ML_TYPE(MLJobHandleT, (), "jobs::handle");

static ml_job_handle_t *mljobs_make_handle(const char *Id, const char *Script) {
    ml_job_handle_t *H = new(ml_job_handle_t);
    H->Type = MLJobHandleT;
    size_t Ilen = strlen(Id);
    char *IdCopy = snew(Ilen + 1);
    memcpy(IdCopy, Id, Ilen + 1);
    H->Id = IdCopy;
    if (Script) {
        size_t Slen = strlen(Script);
        char *SCopy = snew(Slen + 1);
        memcpy(SCopy, Script, Slen + 1);
        H->Script = SCopy;
    } else {
        H->Script = "";
    }
    return H;
}

static const char *mljobs_extract_id(ml_value_t *Arg, ml_value_t **OutErr) {
    Arg = ml_deref(Arg);
    if (ml_is(Arg, MLJobHandleT)) {
        return ((ml_job_handle_t *)Arg)->Id;
    }
    if (ml_is(Arg, MLStringT)) {
        return ml_string_value(Arg);
    }
    if (ml_is(Arg, MLMapT)) {
        ml_value_t *IdV = ml_map_search(Arg, ml_cstring("id"));
        if (IdV && ml_is(IdV, MLStringT)) return ml_string_value(IdV);
    }
    *OutErr = ml_error("TypeError", "Expected a jobs::handle or job id string");
    return NULL;
}

static ml_value_t *mljobs_fetch_status(const char *Id) {
    char Path[256];
    snprintf(Path, sizeof(Path), "/api/jobs/%s", Id);
    int Status = 0;
    ml_value_t *Resp = mljobs_http_json("GET", Path, NULL, 0, &Status);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Job = ml_map_search(Resp, ml_cstring("job"));
        if (Job) return Job;
    }
    return Resp;
}

static ml_value_t *mljobs_wait_impl(const char *Id, int64_t TimeoutMs, int UnwrapResult) {
    char Path[256];
    snprintf(Path, sizeof(Path), "/api/jobs/%s/wait", Id);
    ml_value_t *Req = ml_map();
    if (TimeoutMs > 0) {
        ml_map_insert(Req, ml_cstring("timeout_ms"), ml_integer(TimeoutMs));
    }
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Err = ml_json_encode(Sb, Req);
    if (Err) return Err;
    size_t Len = Sb->Length;
    const char *Str = ml_stringbuffer_get_string(Sb);

    int Status = 0;
    ml_value_t *Resp = mljobs_http_json("POST", Path, Str, Len, &Status);
    if (ml_is_error(Resp)) return Resp;

    ml_value_t *Job = Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Inner = ml_map_search(Resp, ml_cstring("job"));
        if (Inner) Job = Inner;
    }
    if (!UnwrapResult) return Job;

    if (ml_is(Job, MLMapT)) {
        ml_value_t *St = ml_map_search(Job, ml_cstring("status"));
        if (St && ml_is(St, MLStringT)) {
            const char *Sts = ml_string_value(St);
            if (strcmp(Sts, "failed") == 0 || strcmp(Sts, "cancelled") == 0) {
                ml_value_t *ErrV = ml_map_search(Job, ml_cstring("error"));
                const char *Msg = (ErrV && ml_is(ErrV, MLStringT)) ? ml_string_value(ErrV) : Sts;
                return ml_error("JobError", "Background job '%s' %s: %s", Id, Sts, Msg);
            }
            if (strcmp(Sts, "running") == 0) {
                return ml_error("JobError", "Timed out waiting for background job '%s'", Id);
            }
        }
        ml_value_t *Plain = ml_map_search(Job, ml_cstring("result_plain"));
        if (Plain) return Plain;
    }
    return MLNil;
}

static ml_value_t *mljobs_stop_impl(const char *Id) {
    char Path[256];
    snprintf(Path, sizeof(Path), "/api/jobs/%s/stop", Id);
    int Status = 0;
    ml_value_t *Resp = mljobs_http_json("POST", Path, "{}", 2, &Status);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Job = ml_map_search(Resp, ml_cstring("job"));
        if (Job) return Job;
    }
    return Resp;
}

/* ============================================================================
 * Module Functions
 * ============================================================================ */

/* jobs::start(script, params?, options?) + named args: name, function, args */
ML_FUNCTION(MLJobsStart) {
    ml_value_t *NamedName = NULL;
    ml_value_t *NamedFn = NULL;
    ml_value_t *NamedArgs = NULL;
    ml_value_t *NamedParams = NULL;
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
                if (strcmp(Key, "name") == 0) NamedName = Val;
                else if (strcmp(Key, "function") == 0) NamedFn = Val;
                else if (strcmp(Key, "args") == 0) NamedArgs = Val;
                else if (strcmp(Key, "params") == 0) NamedParams = Val;
            }
            break;
        }
    }

    if (PosCount < 1) {
        return ml_error("CallError", "jobs::start requires at least 1 argument (script path)");
    }
    ml_value_t *ScriptVal = ml_deref(Args[0]);
    if (!ml_is(ScriptVal, MLStringT)) {
        return ml_error("TypeError", "jobs::start script path must be a string");
    }

    ml_value_t *Req = ml_map();
    ml_map_insert(Req, ml_cstring("script"), ScriptVal);
    ml_map_insert(Req, ml_cstring("source"), ml_cstring("minilang"));

    char *Cwd = getcwd(NULL, 0);
    if (Cwd) {
        ml_map_insert(Req, ml_cstring("cwd"), ml_string_copy(Cwd, (int)strlen(Cwd)));
        free(Cwd);
    }

    ml_value_t *ParamsVal = (PosCount >= 2 && ml_deref(Args[1]) != MLNil) ? ml_deref(Args[1]) : NamedParams;
    if (ParamsVal && ParamsVal != MLNil) {
        if (!ml_is(ParamsVal, MLMapT)) {
            return ml_error("TypeError", "jobs::start params must be a map or nil");
        }
        ml_map_insert(Req, ml_cstring("params"), mljobs_to_json_safe(ParamsVal));
    }

    if (PosCount >= 3 && ml_deref(Args[2]) != MLNil) {
        ml_value_t *Opt = ml_deref(Args[2]);
        if (ml_is(Opt, MLStringT)) {
            if (!NamedName) NamedName = Opt;
        } else if (ml_is(Opt, MLMapT)) {
            ml_value_t *N = ml_map_search(Opt, ml_cstring("name"));
            if (N && N != MLNil && !NamedName) NamedName = N;
            ml_value_t *F = ml_map_search(Opt, ml_cstring("function"));
            if (F && F != MLNil && !NamedFn) NamedFn = F;
            ml_value_t *A = ml_map_search(Opt, ml_cstring("args"));
            if (A && A != MLNil && !NamedArgs) NamedArgs = A;
        }
    }

    if (NamedName && NamedName != MLNil) ml_map_insert(Req, ml_cstring("name"), mljobs_to_json_safe(NamedName));
    if (NamedFn && NamedFn != MLNil) ml_map_insert(Req, ml_cstring("function"), mljobs_to_json_safe(NamedFn));
    if (NamedArgs && NamedArgs != MLNil) ml_map_insert(Req, ml_cstring("args"), mljobs_to_json_safe(NamedArgs));

    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Err = ml_json_encode(Sb, Req);
    if (Err) return Err;
    size_t Len = Sb->Length;
    const char *Str = ml_stringbuffer_get_string(Sb);

    int Status = 0;
    ml_value_t *Resp = mljobs_http_json("POST", "/api/jobs", Str, Len, &Status);
    if (ml_is_error(Resp)) return Resp;

    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Job = ml_map_search(Resp, ml_cstring("job"));
        if (Job && ml_is(Job, MLMapT)) {
            ml_value_t *IdV = ml_map_search(Job, ml_cstring("id"));
            ml_value_t *ScV = ml_map_search(Job, ml_cstring("script"));
            if (IdV && ml_is(IdV, MLStringT)) {
                return (ml_value_t *)mljobs_make_handle(
                    ml_string_value(IdV),
                    (ScV && ml_is(ScV, MLStringT)) ? ml_string_value(ScV) : ml_string_value(ScriptVal)
                );
            }
        }
    }
    return Resp;
}

ML_FUNCTION(MLJobsList) {
    int Status = 0;
    ml_value_t *Resp = mljobs_http_json("GET", "/api/jobs", NULL, 0, &Status);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Jobs = ml_map_search(Resp, ml_cstring("jobs"));
        if (Jobs) return Jobs;
    }
    return Resp;
}

ML_FUNCTION(MLJobsStatus) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Err = NULL;
    const char *Id = mljobs_extract_id(Args[0], &Err);
    if (!Id) return Err;
    return mljobs_fetch_status(Id);
}

ML_FUNCTION(MLJobsWait) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Err = NULL;
    const char *Id = mljobs_extract_id(Args[0], &Err);
    if (!Id) return Err;
    int64_t TimeoutMs = 0;
    if (Count >= 2 && ml_deref(Args[1]) != MLNil) {
        ml_value_t *T = ml_deref(Args[1]);
        if (ml_is(T, MLIntegerT)) TimeoutMs = ml_integer_value(T);
        else if (ml_is(T, MLRealT)) TimeoutMs = (int64_t)ml_real_value(T);
    }
    return mljobs_wait_impl(Id, TimeoutMs, 1);
}

ML_FUNCTION(MLJobsJoin) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Err = NULL;
    const char *Id = mljobs_extract_id(Args[0], &Err);
    if (!Id) return Err;
    int64_t TimeoutMs = 0;
    if (Count >= 2 && ml_deref(Args[1]) != MLNil) {
        ml_value_t *T = ml_deref(Args[1]);
        if (ml_is(T, MLIntegerT)) TimeoutMs = ml_integer_value(T);
        else if (ml_is(T, MLRealT)) TimeoutMs = (int64_t)ml_real_value(T);
    }
    return mljobs_wait_impl(Id, TimeoutMs, 0);
}

ML_FUNCTION(MLJobsOutput) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Err = NULL;
    const char *Id = mljobs_extract_id(Args[0], &Err);
    if (!Id) return Err;
    ml_value_t *Job = mljobs_fetch_status(Id);
    if (ml_is_error(Job)) return Job;
    if (ml_is(Job, MLMapT)) {
        ml_value_t *Out = ml_map_search(Job, ml_cstring("stdout"));
        if (Out) return Out;
    }
    return ml_string("", 0);
}

ML_FUNCTION(MLJobsStop) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Err = NULL;
    const char *Id = mljobs_extract_id(Args[0], &Err);
    if (!Id) return Err;
    return mljobs_stop_impl(Id);
}

ML_FUNCTION(MLJobsClear) {
    int Status = 0;
    return mljobs_http_json("POST", "/api/jobs/clear", "{}", 2, &Status);
}

ML_FUNCTION(MLJobsSleep) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *V = ml_deref(Args[0]);
    double Secs = 0.0;
    if (ml_is(V, MLIntegerT)) Secs = (double)ml_integer_value(V);
    else if (ml_is(V, MLRealT)) Secs = ml_real_value(V);
    else return ml_error("TypeError", "sleep expects a number of seconds");
    if (Secs > 0.0) {
        struct timespec Ts;
        Ts.tv_sec = (time_t)Secs;
        Ts.tv_nsec = (long)((Secs - (double)Ts.tv_sec) * 1e9);
        nanosleep(&Ts, NULL);
    }
    return MLNil;
}

/* ============================================================================
 * Methods on jobs::handle
 * ============================================================================ */

static ml_value_t *mljob_m_id(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    return ml_string(H->Id, -1);
}

static ml_value_t *mljob_m_status(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    return mljobs_fetch_status(H->Id);
}

static ml_value_t *mljob_m_running(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    ml_value_t *Job = mljobs_fetch_status(H->Id);
    if (ml_is_error(Job)) return Job;
    if (ml_is(Job, MLMapT)) {
        ml_value_t *St = ml_map_search(Job, ml_cstring("status"));
        if (St && ml_is(St, MLStringT) && strcmp(ml_string_value(St), "running") == 0) {
            return ml_boolean(1);
        }
    }
    return MLNil;
}

static ml_value_t *mljob_m_wait(void *Data, int Count, ml_value_t **Args) {
    int Unwrap = (Data != NULL);
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    int64_t TimeoutMs = 0;
    if (Count >= 2 && ml_deref(Args[1]) != MLNil) {
        ml_value_t *T = ml_deref(Args[1]);
        if (ml_is(T, MLIntegerT)) TimeoutMs = ml_integer_value(T);
        else if (ml_is(T, MLRealT)) TimeoutMs = (int64_t)ml_real_value(T);
    }
    return mljobs_wait_impl(H->Id, TimeoutMs, Unwrap);
}

static ml_value_t *mljob_m_result(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    ml_value_t *Job = mljobs_fetch_status(H->Id);
    if (ml_is_error(Job)) return Job;
    if (ml_is(Job, MLMapT)) {
        ml_value_t *Plain = ml_map_search(Job, ml_cstring("result_plain"));
        if (Plain) return Plain;
    }
    return MLNil;
}

static ml_value_t *mljob_m_output(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    ml_value_t *Job = mljobs_fetch_status(H->Id);
    if (ml_is_error(Job)) return Job;
    if (ml_is(Job, MLMapT)) {
        ml_value_t *Out = ml_map_search(Job, ml_cstring("stdout"));
        if (Out) return Out;
    }
    return ml_string("", 0);
}

static ml_value_t *mljob_m_stop(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_job_handle_t *H = (ml_job_handle_t *)Args[0];
    return mljobs_stop_impl(H->Id);
}

static ml_value_t *mljob_m_sb_append(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_stringbuffer_t *Sb = (ml_stringbuffer_t *)Args[0];
    ml_job_handle_t *H = (ml_job_handle_t *)Args[1];
    ml_stringbuffer_printf(Sb, "<job %s (%s)>", H->Id, H->Script);
    return MLSome;
}

void ml_jobs_init(stringmap_t *Globals) {
    ml_type_init(MLJobHandleT, NULL);

    ml_method_definev(ml_method("id"), ml_cfunction(NULL, (ml_callback_t)mljob_m_id), NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("status"), ml_cfunction(NULL, (ml_callback_t)mljob_m_status), NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("running"), ml_cfunction(NULL, (ml_callback_t)mljob_m_running), NULL, MLJobHandleT, NULL);

    ml_value_t *WaitFn = ml_cfunction((void *)1, (ml_callback_t)mljob_m_wait);
    ml_method_definev(ml_method("wait"), WaitFn, NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("wait"), WaitFn, NULL, MLJobHandleT, MLAnyT, NULL);

    ml_value_t *JoinFn = ml_cfunction(NULL, (ml_callback_t)mljob_m_wait);
    ml_method_definev(ml_method("join"), JoinFn, NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("join"), JoinFn, NULL, MLJobHandleT, MLAnyT, NULL);

    ml_method_definev(ml_method("result"), ml_cfunction(NULL, (ml_callback_t)mljob_m_result), NULL, MLJobHandleT, NULL);

    ml_value_t *OutFn = ml_cfunction(NULL, (ml_callback_t)mljob_m_output);
    ml_method_definev(ml_method("stdout"), OutFn, NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("output"), OutFn, NULL, MLJobHandleT, NULL);

    ml_value_t *StopFn = ml_cfunction(NULL, (ml_callback_t)mljob_m_stop);
    ml_method_definev(ml_method("stop"), StopFn, NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("cancel"), StopFn, NULL, MLJobHandleT, NULL);
    ml_method_definev(ml_method("kill"), StopFn, NULL, MLJobHandleT, NULL);

    ml_method_definev(
        ml_method("append"),
        ml_cfunction(NULL, (ml_callback_t)mljob_m_sb_append),
        NULL,
        MLStringBufferT,
        MLJobHandleT,
        NULL
    );

    ml_value_t *JobsMod = ml_module("jobs",
        "start", MLJobsStart,
        "run", MLJobsStart,
        "spawn", MLJobsStart,
        "list", MLJobsList,
        "get", MLJobsStatus,
        "status", MLJobsStatus,
        "wait", MLJobsWait,
        "join", MLJobsJoin,
        "output", MLJobsOutput,
        "stdout", MLJobsOutput,
        "stop", MLJobsStop,
        "cancel", MLJobsStop,
        "kill", MLJobsStop,
        "clear", MLJobsClear,
        "sleep", MLJobsSleep,
        "handle", MLJobHandleT,
        NULL
    );

    stringmap_insert(Globals, "jobs", JobsMod);
    stringmap_insert(Globals, "sleep", MLJobsSleep);
    ml_externals_default_add("jobs", JobsMod);
    ml_externals_default_add("sleep", MLJobsSleep);
}
