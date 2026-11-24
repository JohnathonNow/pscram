#include "ml_service.h"
#include "ml_ui.h"
#include "ml_macros.h"
#include "ml_json.h"
#include "ml_types.h"
#include "ml_time.h"
#include "ml_uuid.h"
#include "ml_base64.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

extern void mlk_write_tagged_json(ml_stringbuffer_t *sb, ml_value_t *Val, int depth);

/* ============================================================================
 * Minimal Localhost HTTP/1.1 JSON Client (loopback to minilang-notebook server)
 * ============================================================================ */

static int mlsvc_parse_internal_url(char *HostBuf, size_t HostCap, int *OutPort) {
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

static char *mlsvc_decode_chunked(const char *Src, size_t SrcLen, size_t *OutLen) {
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

static void mlsvc_url_encode(const char *Src, char *Dst, size_t Cap) {
    static const char Hex[] = "0123456789ABCDEF";
    size_t j = 0;
    for (size_t i = 0; Src && Src[i] && j + 4 < Cap; ++i) {
        unsigned char c = (unsigned char)Src[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            Dst[j++] = (char)c;
        } else {
            Dst[j++] = '%';
            Dst[j++] = Hex[(c >> 4) & 0xF];
            Dst[j++] = Hex[c & 0xF];
        }
    }
    Dst[j] = '\0';
}

static ml_value_t *mlsvc_http_json(
    const char *Method,
    const char *Path,
    const char *JsonBody,
    size_t BodyLen,
    int *OutStatus
) {
    char Host[128];
    int Port = 0;
    if (mlsvc_parse_internal_url(Host, sizeof(Host), &Port) != 0) {
        return ml_error("ServiceError", "Background services API is unavailable (MINILANG_INTERNAL_URL not set)");
    }

    int Sock = socket(AF_INET, SOCK_STREAM, 0);
    if (Sock < 0) {
        return ml_error("ServiceError", "Failed to create socket: %s", strerror(errno));
    }

    struct sockaddr_in Addr;
    memset(&Addr, 0, sizeof(Addr));
    Addr.sin_family = AF_INET;
    Addr.sin_port = htons((uint16_t)Port);
    if (inet_pton(AF_INET, Host, &Addr.sin_addr) != 1) {
        struct hostent *He = gethostbyname(Host);
        if (!He || !He->h_addr_list || !He->h_addr_list[0]) {
            close(Sock);
            return ml_error("ServiceError", "Could not resolve internal server host '%s'", Host);
        }
        memcpy(&Addr.sin_addr, He->h_addr_list[0], sizeof(Addr.sin_addr));
    }

    if (connect(Sock, (struct sockaddr *)&Addr, sizeof(Addr)) != 0) {
        int Err = errno;
        close(Sock);
        return ml_error("ServiceError", "Failed to connect to service server %s:%d: %s", Host, Port, strerror(Err));
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
            return ml_error("ServiceError", "Failed sending request headers to service server");
        }
        Sent += (size_t)N;
    }

    if (JsonBody && BodyLen > 0) {
        Sent = 0;
        while (Sent < BodyLen) {
            ssize_t N = send(Sock, JsonBody + Sent, BodyLen - Sent, 0);
            if (N <= 0) {
                close(Sock);
                return ml_error("ServiceError", "Failed sending request body to service server");
            }
            Sent += (size_t)N;
        }
    }

    size_t Cap = 4096;
    size_t Len = 0;
    char *Buf = (char *)malloc(Cap);
    if (!Buf) {
        close(Sock);
        return ml_error("ServiceError", "Out of memory reading service response");
    }

    for (;;) {
        if (Len + 2048 >= Cap) {
            Cap *= 2;
            char *Tmp = (char *)realloc(Buf, Cap);
            if (!Tmp) {
                free(Buf);
                close(Sock);
                return ml_error("ServiceError", "Out of memory growing service response buffer");
            }
            Buf = Tmp;
        }
        ssize_t N = recv(Sock, Buf + Len, Cap - Len - 1, 0);
        if (N < 0) {
            if (errno == EINTR) continue;
            free(Buf);
            close(Sock);
            return ml_error("ServiceError", "Error reading response from service server: %s", strerror(errno));
        }
        if (N == 0) break;
        Len += (size_t)N;
    }
    Buf[Len] = '\0';
    close(Sock);

    char *Sep = strstr(Buf, "\r\n\r\n");
    if (!Sep) {
        free(Buf);
        return ml_error("ServiceError", "Malformed HTTP response from service server");
    }

    int Status = 0;
    const char *Sp = strchr(Buf, ' ');
    if (Sp) Status = atoi(Sp + 1);
    if (OutStatus) *OutStatus = Status;

    *Sep = '\0';
    const char *Headers = Buf;
    const char *RawBody = Sep + 4;
    size_t RawLen = Len - (size_t)(RawBody - Buf);

    int IsChunked = (strcasestr(Headers, "transfer-encoding: chunked") != NULL);
    const char *FinalBody = RawBody;
    size_t FinalLen = RawLen;
    char *Decoded = NULL;
    if (IsChunked) {
        Decoded = mlsvc_decode_chunked(RawBody, RawLen, &FinalLen);
        if (Decoded) FinalBody = Decoded;
    }

    ml_value_t *Parsed = (FinalLen > 0) ? ml_json_decode(FinalBody, FinalLen) : ml_map();
    if (Decoded) free(Decoded);
    free(Buf);

    if (Status >= 400) {
        if (ml_is(Parsed, MLMapT)) {
            ml_value_t *ErrVal = ml_map_search(Parsed, ml_cstring("error"));
            if (ErrVal && ml_is(ml_deref(ErrVal), MLStringT)) {
                return ml_error("ServiceError", "%s", ml_string_value(ml_deref(ErrVal)));
            }
        }
        return ml_error("ServiceError", "Service API returned HTTP %d", Status);
    }
    return Parsed;
}

static void mlsvc_json_write_str(ml_stringbuffer_t *sb, const char *s, size_t len) {
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
                if (c < 0x20) ml_stringbuffer_printf(sb, "\\u%04x", c);
                else ml_stringbuffer_put(sb, (char)c);
                break;
        }
    }
    ml_stringbuffer_write(sb, "\"", 1);
}

/* Convert a decoded JSON value that may be a Tagged JSON object {"type": ..., "value": ...}
 * back into its native Minilang value! Plain JSON values pass through unchanged. */
static ml_value_t *mlsvc_tagged_to_ml(ml_value_t *V) {
    if (!V) return MLNil;
    V = ml_deref(V);
    if (!V || V == MLNil) return MLNil;
    if (!ml_is(V, MLMapT)) return V;

    ml_value_t *TyVal = ml_map_search(V, ml_cstring("type"));
    if (!TyVal || !ml_is(ml_deref(TyVal), MLStringT)) {
        return V;
    }
    int Size = ml_map_size(V);
    ml_value_t *Inner = ml_map_search(V, ml_cstring("value"));
    if (Size > 2 || (Size == 2 && !Inner)) {
        return V;
    }
    const char *Ty = ml_string_value(ml_deref(TyVal));
    ml_value_t *Val = Inner ? ml_deref(Inner) : MLNil;

    if (strcmp(Ty, "nil") == 0 || strcmp(Ty, "null") == 0) {
        return MLNil;
    } else if (strcmp(Ty, "boolean") == 0 || strcmp(Ty, "bool") == 0) {
        if (ml_is(Val, MLBooleanT)) return Val;
        return (Val != MLNil) ? ml_boolean(1) : ml_boolean(0);
    } else if (strcmp(Ty, "integer") == 0 || strcmp(Ty, "int") == 0) {
        if (ml_is(Val, MLIntegerT)) return Val;
        if (ml_is(Val, MLRealT)) return ml_integer((int64_t)ml_real_value(Val));
        return Val;
    } else if (strcmp(Ty, "real") == 0 || strcmp(Ty, "float") == 0) {
        if (ml_is(Val, MLRealT)) return Val;
        if (ml_is(Val, MLIntegerT)) return ml_real((double)ml_integer_value(Val));
        return Val;
    } else if (strcmp(Ty, "string") == 0 || strcmp(Ty, "str") == 0) {
        return Val;
    } else if (strcmp(Ty, "symbol") == 0 && ml_is(Val, MLStringT)) {
        return ml_method(ml_string_value(Val));
    } else if (strcmp(Ty, "time") == 0 && ml_is(Val, MLStringT)) {
        ml_value_t *Parsed = ml_time_parse(ml_string_value(Val), ml_string_length(Val));
        return ml_is_error(Parsed) ? Val : Parsed;
    } else if (strcmp(Ty, "uuid") == 0 && ml_is(Val, MLStringT)) {
        ml_value_t *Parsed = ml_uuid_parse(ml_string_value(Val), ml_string_length(Val));
        return ml_is_error(Parsed) ? Val : Parsed;
    } else if (strcmp(Ty, "list") == 0 && ml_is(Val, MLListT)) {
        ml_value_t *Out = ml_list();
        ML_LIST_FOREACH(Val, Node) {
            ml_list_put(Out, mlsvc_tagged_to_ml(Node->Value));
        }
        return Out;
    } else if (strcmp(Ty, "tuple") == 0 && ml_is(Val, MLListT)) {
        int N = ml_list_length(Val);
        ml_value_t *Out = ml_tuple(N);
        int Idx = 1;
        ML_LIST_FOREACH(Val, Node) {
            ml_tuple_set(Out, Idx++, mlsvc_tagged_to_ml(Node->Value));
        }
        return Out;
    } else if (strcmp(Ty, "set") == 0 && ml_is(Val, MLListT)) {
        ml_value_t *Out = ml_set();
        ML_LIST_FOREACH(Val, Node) {
            ml_set_insert(Out, mlsvc_tagged_to_ml(Node->Value));
        }
        return Out;
    } else if (strcmp(Ty, "map") == 0) {
        ml_value_t *Out = ml_map();
        if (ml_is(Val, MLMapT)) {
            ML_MAP_FOREACH(Val, Node) {
                ml_map_insert(Out, Node->Key, mlsvc_tagged_to_ml(Node->Value));
            }
        } else if (ml_is(Val, MLListT)) {
            ML_LIST_FOREACH(Val, Node) {
                ml_value_t *Pair = ml_deref(Node->Value);
                if (ml_is(Pair, MLListT) && ml_list_length(Pair) >= 2) {
                    ml_value_t *K = mlsvc_tagged_to_ml(ml_list_get(Pair, 1));
                    ml_value_t *MV = mlsvc_tagged_to_ml(ml_list_get(Pair, 2));
                    ml_map_insert(Out, K, MV);
                }
            }
        }
        return Out;
    }
    return V;
}

static ml_value_t *mlsvc_unpack_message(ml_value_t *RawMsg) {
    if (!RawMsg || !ml_is(ml_deref(RawMsg), MLMapT)) return MLNil;
    ml_value_t *Msg = ml_deref(RawMsg);
    ml_value_t *Out = ml_map();
    ML_MAP_FOREACH(Msg, Node) {
        ml_value_t *K = ml_deref(Node->Key);
        ml_value_t *V = ml_deref(Node->Value);
        if (ml_is(K, MLStringT) && strcmp(ml_string_value(K), "data") == 0) {
            ml_map_insert(Out, K, mlsvc_tagged_to_ml(V));
        } else {
            ml_map_insert(Out, K, V);
        }
    }
    return Out;
}

static const char *mlsvc_current_name(void) {
    const char *Name = getenv("MINILANG_SERVICE_NAME");
    if (Name && *Name) return Name;
    const char *Id = getenv("MINILANG_SERVICE_ID");
    if (Id && *Id) return Id;
    return NULL;
}

/* ============================================================================
 * Minilang `service` Module Functions
 * ============================================================================ */

/* service::self() -> {id, name} or nil */
ML_FUNCTION(MLSvcSelf) {
    const char *Name = getenv("MINILANG_SERVICE_NAME");
    const char *Id = getenv("MINILANG_SERVICE_ID");
    if ((!Name || !*Name) && (!Id || !*Id)) return MLNil;
    ml_value_t *Map = ml_map();
    if (Id && *Id) ml_map_insert(Map, ml_cstring("id"), ml_string_copy(Id, (int)strlen(Id)));
    if (Name && *Name) ml_map_insert(Map, ml_cstring("name"), ml_string_copy(Name, (int)strlen(Name)));
    return Map;
}

/* service::start(script, opts?) OR service::start(name, script, params_or_opts?) */
ML_FUNCTION(MLSvcStart) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    const char *Arg0 = ml_string_value(Args[0]);
    const char *Name = NULL;
    const char *Script = NULL;
    ml_value_t *Params = NULL;
    int Replace = 0;

    if (Count >= 2 && ml_is(ml_deref(Args[1]), MLStringT)) {
        Name = Arg0;
        Script = ml_string_value(ml_deref(Args[1]));
        if (Count >= 3 && ml_is(ml_deref(Args[2]), MLMapT)) {
            ml_value_t *Third = ml_deref(Args[2]);
            ml_value_t *P = ml_map_search(Third, ml_cstring("params"));
            ml_value_t *R = ml_map_search(Third, ml_cstring("replace"));
            if (P || R) {
                if (P) Params = ml_deref(P);
                if (R && ml_deref(R) != MLNil && !(ml_is(ml_deref(R), MLBooleanT) && !ml_boolean_value(ml_deref(R)))) {
                    Replace = 1;
                }
            } else {
                Params = Third;
            }
        }
    } else {
        Script = Arg0;
        if (Count >= 2 && ml_is(ml_deref(Args[1]), MLMapT)) {
            ml_value_t *Opts = ml_deref(Args[1]);
            ml_value_t *N = ml_map_search(Opts, ml_cstring("name"));
            if (N && ml_is(ml_deref(N), MLStringT)) Name = ml_string_value(ml_deref(N));
            ml_value_t *P = ml_map_search(Opts, ml_cstring("params"));
            if (P) Params = ml_deref(P);
            ml_value_t *R = ml_map_search(Opts, ml_cstring("replace"));
            if (R && ml_deref(R) != MLNil && !(ml_is(ml_deref(R), MLBooleanT) && !ml_boolean_value(ml_deref(R)))) {
                Replace = 1;
            }
        }
    }

    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_write(Sb, "{\"script\":", 10);
    mlsvc_json_write_str(Sb, Script, strlen(Script));
    if (Name && *Name) {
        ml_stringbuffer_write(Sb, ",\"name\":", 8);
        mlsvc_json_write_str(Sb, Name, strlen(Name));
    }
    if (Replace) {
        ml_stringbuffer_write(Sb, ",\"replace\":true", 15);
    }
    char Cwd[4096];
    if (getcwd(Cwd, sizeof(Cwd))) {
        ml_stringbuffer_write(Sb, ",\"cwd\":", 7);
        mlsvc_json_write_str(Sb, Cwd, strlen(Cwd));
    }
    if (Params && ml_is(Params, MLMapT)) {
        ml_stringbuffer_write(Sb, ",\"params\":{", 11);
        int First = 1;
        ML_MAP_FOREACH(Params, Node) {
            ml_value_t *K = ml_deref(Node->Key);
            if (!ml_is(K, MLStringT)) continue;
            if (!First) ml_stringbuffer_write(Sb, ",", 1);
            First = 0;
            mlsvc_json_write_str(Sb, ml_string_value(K), ml_string_length(K));
            ml_stringbuffer_write(Sb, ":", 1);
            mlk_write_tagged_json(Sb, Node->Value, 0);
        }
        ml_stringbuffer_write(Sb, "}", 1);
    }
    ml_stringbuffer_write(Sb, "}", 1);

    size_t BodyLen = Sb->Length;
    const char *Body = ml_stringbuffer_get_string(Sb);
    ml_value_t *Resp = mlsvc_http_json("POST", "/api/services", Body, BodyLen, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Svc = ml_map_search(Resp, ml_cstring("service"));
        if (Svc) return ml_deref(Svc);
    }
    return Resp;
}

/* service::list() */
ML_FUNCTION(MLSvcList) {
    ml_value_t *Resp = mlsvc_http_json("GET", "/api/services", NULL, 0, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *List = ml_map_search(Resp, ml_cstring("services"));
        if (List) return ml_deref(List);
    }
    return Resp;
}

/* service::status(name_or_id) */
ML_FUNCTION(MLSvcStatus) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    char Enc[256], Path[384];
    mlsvc_url_encode(ml_string_value(Args[0]), Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s", Enc);
    ml_value_t *Resp = mlsvc_http_json("GET", Path, NULL, 0, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Svc = ml_map_search(Resp, ml_cstring("service"));
        if (Svc) return ml_deref(Svc);
    }
    return Resp;
}

/* service::stop(name_or_id) */
ML_FUNCTION(MLSvcStop) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    char Enc[256], Path[384];
    mlsvc_url_encode(ml_string_value(Args[0]), Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s/stop", Enc);
    ml_value_t *Resp = mlsvc_http_json("POST", Path, "{}", 2, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Svc = ml_map_search(Resp, ml_cstring("service"));
        if (Svc) return ml_deref(Svc);
    }
    return Resp;
}

/* service::restart(name_or_id) */
ML_FUNCTION(MLSvcRestart) {
    ML_CHECK_ARG_COUNT(1);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    char Enc[256], Path[384];
    mlsvc_url_encode(ml_string_value(Args[0]), Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s/restart", Enc);
    ml_value_t *Resp = mlsvc_http_json("POST", Path, "{}", 2, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Svc = ml_map_search(Resp, ml_cstring("service"));
        if (Svc) return ml_deref(Svc);
    }
    return Resp;
}

/* service::clients(name_or_id?) -> list of connected UI client_ids */
ML_FUNCTION(MLSvcClients) {
    const char *Target = (Count >= 1 && ml_is(ml_deref(Args[0]), MLStringT))
        ? ml_string_value(ml_deref(Args[0]))
        : mlsvc_current_name();
    if (!Target) return ml_error("ServiceError", "service::clients() requires a service name when called outside a service");
    char Enc[256], Path[384];
    mlsvc_url_encode(Target, Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s", Enc);
    ml_value_t *Resp = mlsvc_http_json("GET", Path, NULL, 0, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Svc = ml_map_search(Resp, ml_cstring("service"));
        if (Svc && ml_is(ml_deref(Svc), MLMapT)) {
            ml_value_t *Clients = ml_map_search(ml_deref(Svc), ml_cstring("clients"));
            if (Clients) return ml_deref(Clients);
        }
    }
    return ml_list();
}

/* service::recv(timeout_ms?) -> message map or nil */
ML_FUNCTION(MLSvcRecv) {
    const char *Me = mlsvc_current_name();
    if (!Me) {
        return ml_error("ServiceError", "service::recv() can only be called inside a running background service");
    }
    int64_t TimeoutMs = -1;
    if (Count >= 1) {
        ml_value_t *T = ml_deref(Args[0]);
        if (ml_is(T, MLIntegerT)) TimeoutMs = ml_integer_value(T);
        else if (ml_is(T, MLRealT)) TimeoutMs = (int64_t)ml_real_value(T);
    }

    char Enc[256], Path[384];
    mlsvc_url_encode(Me, Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s/recv", Enc);

    /* Loop in <= 25s HTTP chunks when waiting indefinitely (TimeoutMs < 0) so sockets never time out */
    for (;;) {
        int64_t ChunkMs = (TimeoutMs < 0) ? 25000 : TimeoutMs;
        char Body[128];
        int BodyLen = snprintf(Body, sizeof(Body), "{\"timeout_ms\":%lld}", (long long)ChunkMs);
        ml_value_t *Resp = mlsvc_http_json("POST", Path, Body, (size_t)BodyLen, NULL);
        if (ml_is_error(Resp)) return Resp;
        if (ml_is(Resp, MLMapT)) {
            ml_value_t *Closed = ml_map_search(Resp, ml_cstring("closed"));
            if (Closed && ml_is(ml_deref(Closed), MLBooleanT) && ml_boolean_value(ml_deref(Closed))) {
                return MLNil;
            }
            ml_value_t *Msg = ml_map_search(Resp, ml_cstring("message"));
            if (Msg && ml_deref(Msg) != MLNil) {
                return mlsvc_unpack_message(Msg);
            }
        }
        if (TimeoutMs >= 0) return MLNil;
    }
}

/* service::broadcast(topic, data?) -> emits to ALL UIs subscribed to the current service
 * (or service::broadcast(service_name, topic, data) when called externally with 3 args) */
ML_FUNCTION(MLSvcBroadcast) {
    ML_CHECK_ARG_COUNT(1);
    const char *Me = mlsvc_current_name();
    const char *SvcName = Me;
    const char *Topic = NULL;
    ml_value_t *Payload = MLNil;

    if (!Me && Count >= 2 && ml_is(ml_deref(Args[0]), MLStringT) && ml_is(ml_deref(Args[1]), MLStringT)) {
        SvcName = ml_string_value(ml_deref(Args[0]));
        Topic = ml_string_value(ml_deref(Args[1]));
        if (Count >= 3) Payload = Args[2];
    } else {
        ML_CHECK_ARG_TYPE(0, MLStringT);
        Topic = ml_string_value(Args[0]);
        if (Count >= 2) Payload = Args[1];
    }

    if (!SvcName || !*SvcName) {
        return ml_error("ServiceError", "service::broadcast() requires a service name when called outside a service");
    }

    char Enc[256], Path[384];
    mlsvc_url_encode(SvcName, Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s/emit", Enc);

    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_write(Sb, "{\"topic\":", 9);
    mlsvc_json_write_str(Sb, Topic, strlen(Topic));
    if (Me) {
        ml_stringbuffer_write(Sb, ",\"from\":", 8);
        mlsvc_json_write_str(Sb, Me, strlen(Me));
    }
    ml_stringbuffer_write(Sb, ",\"data\":", 8);
    mlk_write_tagged_json(Sb, Payload, 0);
    ml_stringbuffer_write(Sb, "}", 1);

    size_t BodyLen = Sb->Length;
    const char *Body = ml_stringbuffer_get_string(Sb);
    ml_value_t *Resp = mlsvc_http_json("POST", Path, Body, BodyLen, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Delivered = ml_map_search(Resp, ml_cstring("delivered"));
        if (Delivered) return ml_deref(Delivered);
    }
    return ml_integer(0);
}

/* service::send(target, topic, data?)
 * - Inside a service, if target starts with "ui-", emits directly to that UI client!
 * - Otherwise sends to target service's inbox! */
ML_FUNCTION(MLSvcSend) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    ML_CHECK_ARG_TYPE(1, MLStringT);
    const char *Target = ml_string_value(Args[0]);
    const char *Topic = ml_string_value(Args[1]);
    ml_value_t *Payload = (Count >= 3) ? Args[2] : MLNil;
    const char *Me = mlsvc_current_name();

    char Enc[256], Path[384];
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};

    if (Me && strncmp(Target, "ui-", 3) == 0) {
        /* Direct message from service -> specific UI client */
        mlsvc_url_encode(Me, Enc, sizeof(Enc));
        snprintf(Path, sizeof(Path), "/api/services/%s/emit", Enc);
        ml_stringbuffer_write(Sb, "{\"topic\":", 9);
        mlsvc_json_write_str(Sb, Topic, strlen(Topic));
        ml_stringbuffer_write(Sb, ",\"to\":", 6);
        mlsvc_json_write_str(Sb, Target, strlen(Target));
        ml_stringbuffer_write(Sb, ",\"from\":", 8);
        mlsvc_json_write_str(Sb, Me, strlen(Me));
        ml_stringbuffer_write(Sb, ",\"data\":", 8);
        mlk_write_tagged_json(Sb, Payload, 0);
        ml_stringbuffer_write(Sb, "}", 1);
    } else {
        /* Message into target service's inbox */
        mlsvc_url_encode(Target, Enc, sizeof(Enc));
        snprintf(Path, sizeof(Path), "/api/services/%s/send", Enc);
        ml_stringbuffer_write(Sb, "{\"topic\":", 9);
        mlsvc_json_write_str(Sb, Topic, strlen(Topic));
        if (Me) {
            ml_stringbuffer_write(Sb, ",\"from\":", 8);
            mlsvc_json_write_str(Sb, Me, strlen(Me));
        } else {
            ml_stringbuffer_write(Sb, ",\"from\":\"script\"", 16);
        }
        ml_stringbuffer_write(Sb, ",\"data\":", 8);
        mlk_write_tagged_json(Sb, Payload, 0);
        ml_stringbuffer_write(Sb, "}", 1);
    }

    size_t BodyLen = Sb->Length;
    const char *Body = ml_stringbuffer_get_string(Sb);
    return mlsvc_http_json("POST", Path, Body, BodyLen, NULL);
}

/* service::reply(msg_or_reply_id, data?) -> fulfills a pending service::call() */
ML_FUNCTION(MLSvcReply) {
    ML_CHECK_ARG_COUNT(1);
    const char *Me = mlsvc_current_name();
    if (!Me) {
        return ml_error("ServiceError", "service::reply() can only be called inside a running background service");
    }
    const char *ReplyId = NULL;
    ml_value_t *First = ml_deref(Args[0]);
    if (ml_is(First, MLStringT)) {
        ReplyId = ml_string_value(First);
    } else if (ml_is(First, MLMapT)) {
        ml_value_t *R = ml_map_search(First, ml_cstring("reply_to"));
        if (R && ml_is(ml_deref(R), MLStringT)) {
            ReplyId = ml_string_value(ml_deref(R));
        }
    }
    if (!ReplyId || !*ReplyId) {
        return ml_error("ServiceError", "service::reply() expects a message map with 'reply_to' or a reply_to string");
    }
    ml_value_t *Payload = (Count >= 2) ? Args[1] : MLNil;

    char Enc[256], Path[384];
    mlsvc_url_encode(Me, Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s/reply", Enc);

    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_write(Sb, "{\"reply_to\":", 12);
    mlsvc_json_write_str(Sb, ReplyId, strlen(ReplyId));
    ml_stringbuffer_write(Sb, ",\"data\":", 8);
    mlk_write_tagged_json(Sb, Payload, 0);
    ml_stringbuffer_write(Sb, "}", 1);

    size_t BodyLen = Sb->Length;
    const char *Body = ml_stringbuffer_get_string(Sb);
    return mlsvc_http_json("POST", Path, Body, BodyLen, NULL);
}

/* service::call(target_service, topic, data?, timeout_ms?) -> request-reply RPC */
ML_FUNCTION(MLSvcCall) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    ML_CHECK_ARG_TYPE(1, MLStringT);
    const char *Target = ml_string_value(Args[0]);
    const char *Topic = ml_string_value(Args[1]);
    ml_value_t *Payload = (Count >= 3) ? Args[2] : MLNil;
    int64_t TimeoutMs = 15000;
    if (Count >= 4) {
        ml_value_t *T = ml_deref(Args[3]);
        if (ml_is(T, MLIntegerT)) TimeoutMs = ml_integer_value(T);
        else if (ml_is(T, MLRealT)) TimeoutMs = (int64_t)ml_real_value(T);
    }
    const char *Me = mlsvc_current_name();

    char Enc[256], Path[384];
    mlsvc_url_encode(Target, Enc, sizeof(Enc));
    snprintf(Path, sizeof(Path), "/api/services/%s/call", Enc);

    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_write(Sb, "{\"topic\":", 9);
    mlsvc_json_write_str(Sb, Topic, strlen(Topic));
    ml_stringbuffer_write(Sb, ",\"from\":", 8);
    mlsvc_json_write_str(Sb, Me ? Me : "script", Me ? strlen(Me) : 6);
    ml_stringbuffer_printf(Sb, ",\"timeout_ms\":%lld,\"data\":", (long long)TimeoutMs);
    mlk_write_tagged_json(Sb, Payload, 0);
    ml_stringbuffer_write(Sb, "}", 1);

    size_t BodyLen = Sb->Length;
    const char *Body = ml_stringbuffer_get_string(Sb);
    ml_value_t *Resp = mlsvc_http_json("POST", Path, Body, BodyLen, NULL);
    if (ml_is_error(Resp)) return Resp;
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Reply = ml_map_search(Resp, ml_cstring("reply"));
        if (Reply) return mlsvc_tagged_to_ml(Reply);
    }
    return Resp;
}

/* Client-side UI hooks:
 * When called at top-level during `.ui` compilation on the server, `service::on(...)`
 * registers the subscription onto the compiled UI widget bundle so the browser VM
 * subscribes automatically on mount with shared closure/widget references! */
ML_FUNCTION(MLSvcUiOnStub) {
    ML_CHECK_ARG_COUNT(2);
    ML_CHECK_ARG_TYPE(0, MLStringT);
    ml_value_t *SvcName = ml_deref(Args[0]);
    ml_value_t *Topic = ml_cstring("*");
    ml_value_t *Handler = MLNil;
    if (Count == 2) {
        Handler = ml_deref(Args[1]);
    } else {
        Topic = ml_deref(Args[1]);
        Handler = ml_deref(Args[2]);
    }
    if (!ml_is(Handler, MLFunctionT)) {
        return ml_error("TypeError", "service::on() requires a handler function");
    }
    ml_ui_register_service_sub(SvcName, Topic, Handler);
    return MLNil;
}

ML_FUNCTION(MLSvcUiOffStub) {
    return MLNil;
}

ML_FUNCTION(MLSvcUiClientIdStub) {
    const char *Me = mlsvc_current_name();
    return Me ? ml_string_copy(Me, (int)strlen(Me)) : ml_cstring("script");
}

void ml_service_init(stringmap_t *Globals) {
    ml_value_t *SvcMod = ml_module("service",
        "self",      MLSvcSelf,
        "start",     MLSvcStart,
        "stop",      MLSvcStop,
        "restart",   MLSvcRestart,
        "list",      MLSvcList,
        "status",    MLSvcStatus,
        "clients",   MLSvcClients,
        "recv",      MLSvcRecv,
        "broadcast", MLSvcBroadcast,
        "send",      MLSvcSend,
        "reply",     MLSvcReply,
        "call",      MLSvcCall,
        "on",        MLSvcUiOnStub,
        "off",       MLSvcUiOffStub,
        "client_id", MLSvcUiClientIdStub,
        NULL
    );

    stringmap_insert(Globals, "service", SvcMod);

    /* Register externals so .ui scripts referencing `service::...` compile cleanly to MiniJS */
    ml_externals_default_add("service", SvcMod);
    ml_externals_default_add("service::self", MLSvcSelf);
    ml_externals_default_add("service::start", MLSvcStart);
    ml_externals_default_add("service::stop", MLSvcStop);
    ml_externals_default_add("service::restart", MLSvcRestart);
    ml_externals_default_add("service::list", MLSvcList);
    ml_externals_default_add("service::status", MLSvcStatus);
    ml_externals_default_add("service::clients", MLSvcClients);
    ml_externals_default_add("service::recv", MLSvcRecv);
    ml_externals_default_add("service::broadcast", MLSvcBroadcast);
    ml_externals_default_add("service::send", MLSvcSend);
    ml_externals_default_add("service::reply", MLSvcReply);
    ml_externals_default_add("service::call", MLSvcCall);
    ml_externals_default_add("service::on", MLSvcUiOnStub);
    ml_externals_default_add("service::off", MLSvcUiOffStub);
    ml_externals_default_add("service::client_id", MLSvcUiClientIdStub);
}
