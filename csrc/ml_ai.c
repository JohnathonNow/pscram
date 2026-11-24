#include "ml_ai.h"
#include "ml_io.h"
#include "ml_macros.h"
#include "ml_json.h"
#include "ml_types.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#define MLAI_DEFAULT_GEMINI_BASE  "https://generativelanguage.googleapis.com/v1beta"
#define MLAI_DEFAULT_GEMINI_MODEL "gemini-2.5-flash"
#define MLAI_DEFAULT_EMBED_MODEL  "text-embedding-004"

/* ============================================================================
 * Helpers: Environment / Secret Lookup, Options Parsing, Base64, JSON
 * ============================================================================ */

static const char *mlai_secret_or_env(const char *Key) {
    if (!Key || !*Key) return NULL;
    size_t Klen = strlen(Key);
    char *Prefixed = (char *)malloc(Klen + 16);
    const char *Val = NULL;
    if (Prefixed) {
        memcpy(Prefixed, "MLNB_SECRET_", 12);
        memcpy(Prefixed + 12, Key, Klen + 1);
        Val = getenv(Prefixed);
        free(Prefixed);
    }
    if (Val && *Val) return Val;
    Val = getenv(Key);
    if (Val && *Val) return Val;
    return NULL;
}

static const char *mlai_resolve_gemini_key(ml_value_t *Opts) {
    if (Opts && ml_is(Opts, MLMapT)) {
        ml_value_t *K = ml_map_search(Opts, ml_cstring("api_key"));
        if (!K) K = ml_map_search(Opts, ml_cstring("key"));
        if (K && ml_is(ml_deref(K), MLStringT)) {
            const char *S = ml_string_value(ml_deref(K));
            if (S && *S) return S;
        }
    }
    const char *Val = mlai_secret_or_env("GEMINI_API_KEY");
    if (Val) return Val;
    return mlai_secret_or_env("GOOGLE_API_KEY");
}

static const char *mlai_resolve_gemini_base(ml_value_t *Opts) {
    if (Opts && ml_is(Opts, MLMapT)) {
        ml_value_t *B = ml_map_search(Opts, ml_cstring("base_url"));
        if (B && ml_is(ml_deref(B), MLStringT)) {
            const char *S = ml_string_value(ml_deref(B));
            if (S && *S) return S;
        }
    }
    const char *Env = mlai_secret_or_env("GEMINI_API_BASE");
    if (Env) return Env;
    return MLAI_DEFAULT_GEMINI_BASE;
}

static const char *mlai_resolve_gemini_model(ml_value_t *Opts, const char *Fallback) {
    if (Opts && ml_is(Opts, MLMapT)) {
        ml_value_t *M = ml_map_search(Opts, ml_cstring("model"));
        if (M && ml_is(ml_deref(M), MLStringT)) {
            const char *S = ml_string_value(ml_deref(M));
            if (S && *S) return S;
        }
    }
    if (Fallback && strcmp(Fallback, MLAI_DEFAULT_GEMINI_MODEL) == 0) {
        const char *Env = mlai_secret_or_env("GEMINI_MODEL");
        if (Env) return Env;
    }
    return Fallback ? Fallback : MLAI_DEFAULT_GEMINI_MODEL;
}

static const char *mlai_opt_str(ml_value_t *Opts, const char *Key) {
    if (!Opts || !ml_is(Opts, MLMapT)) return NULL;
    ml_value_t *V = ml_map_search(Opts, ml_string(Key, -1));
    if (!V) return NULL;
    V = ml_deref(V);
    if (!V || !ml_is(V, MLStringT)) return NULL;
    const char *S = ml_string_value(V);
    return (S && *S) ? S : NULL;
}

static int mlai_opt_bool(ml_value_t *Opts, const char *Key, int Default) {
    if (!Opts || !ml_is(Opts, MLMapT)) return Default;
    ml_value_t *V = ml_map_search(Opts, ml_string(Key, -1));
    if (!V) return Default;
    V = ml_deref(V);
    if (!V || V == MLNil) return 0;
    if (ml_is(V, MLBooleanT)) return ml_boolean_value(V) ? 1 : 0;
    if (ml_is(V, MLIntegerT)) return ml_integer_value(V) != 0;
    return 1;
}

static int mlai_opt_number(ml_value_t *Opts, const char *Key, double *OutVal) {
    if (!Opts || !ml_is(Opts, MLMapT)) return 0;
    ml_value_t *V = ml_map_search(Opts, ml_string(Key, -1));
    if (!V) return 0;
    V = ml_deref(V);
    if (ml_is(V, MLRealT)) {
        *OutVal = ml_real_value(V);
        return 1;
    }
    if (ml_is(V, MLIntegerT)) {
        *OutVal = (double)ml_integer_value(V);
        return 1;
    }
    return 0;
}

static int mlai_opt_int(ml_value_t *Opts, const char *Key, int64_t *OutVal) {
    if (!Opts || !ml_is(Opts, MLMapT)) return 0;
    ml_value_t *V = ml_map_search(Opts, ml_string(Key, -1));
    if (!V) return 0;
    V = ml_deref(V);
    if (ml_is(V, MLIntegerT)) {
        *OutVal = ml_integer_value(V);
        return 1;
    }
    if (ml_is(V, MLRealT)) {
        *OutVal = (int64_t)ml_real_value(V);
        return 1;
    }
    return 0;
}

static void mlai_merge_map(ml_value_t *Dst, ml_value_t *Src) {
    if (!Dst || !Src) return;
    Src = ml_deref(Src);
    if (!ml_is(Src, MLMapT)) return;
    ML_MAP_FOREACH(Src, Node) {
        ml_map_insert(Dst, ml_deref(Node->Key), ml_deref(Node->Value));
    }
}

/* Split positional args and named args (`key := val` / `key is val`) into
 * OutPos[0..*OutPosCount) and merged OptsMap. If MaxPos >= 0 and a positional map
 * appears at index MaxPos (e.g. `prompt(text, opts_map)`), it is merged into OptsMap. */
static ml_value_t *mlai_parse_args(
    int Count,
    ml_value_t **Args,
    int StartIdx,
    int MaxPos,
    ml_value_t **OutPos,
    int *OutPosCount,
    ml_value_t *BaseOpts
) {
    ml_value_t *Opts = ml_map();
    if (BaseOpts) mlai_merge_map(Opts, BaseOpts);

    int PosCount = 0;
    for (int I = StartIdx; I < Count; ++I) {
        ml_value_t *Arg = ml_deref(Args[I]);
        if (ml_is(Arg, MLNamesT)) {
            int P = I + 1;
            ML_NAMES_FOREACH(Arg, Node) {
                if (P >= Count) break;
                ml_map_insert(Opts, ml_deref(Node->Value), ml_deref(Args[P++]));
            }
            break;
        }
        if (MaxPos >= 0 && PosCount >= MaxPos && ml_is(Arg, MLMapT)) {
            mlai_merge_map(Opts, Arg);
        } else if (PosCount < 8) {
            OutPos[PosCount++] = Arg;
        }
    }
    *OutPosCount = PosCount;
    return Opts;
}

static ml_value_t *mlai_json_encode_str(ml_value_t *Val, char **OutBuf, size_t *OutLen) {
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Err = ml_json_encode(Sb, Val);
    if (Err) return Err;
    size_t Len = Sb->Length;
    const char *S = ml_stringbuffer_get_string(Sb);
    char *Copy = (char *)malloc(Len + 1);
    if (!Copy) return ml_error("AiError", "Out of memory encoding JSON");
    if (Len > 0 && S) memcpy(Copy, S, Len);
    Copy[Len] = '\0';
    *OutBuf = Copy;
    *OutLen = Len;
    return NULL;
}

static ml_value_t *mlai_b64_encode(const unsigned char *Src, size_t Len) {
    static const char Tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t OutLen = ((Len + 2) / 3) * 4;
    char *Buf = snew(OutLen + 1);
    size_t O = 0;
    for (size_t I = 0; I < Len; I += 3) {
        uint32_t B0 = Src[I];
        uint32_t B1 = (I + 1 < Len) ? Src[I + 1] : 0;
        uint32_t B2 = (I + 2 < Len) ? Src[I + 2] : 0;
        uint32_t N = (B0 << 16) | (B1 << 8) | B2;
        Buf[O++] = Tbl[(N >> 18) & 63];
        Buf[O++] = Tbl[(N >> 12) & 63];
        Buf[O++] = (I + 1 < Len) ? Tbl[(N >> 6) & 63] : '=';
        Buf[O++] = (I + 2 < Len) ? Tbl[N & 63] : '=';
    }
    Buf[O] = '\0';
    return ml_string(Buf, (int)O);
}

static const char *mlai_guess_mime_from_ext(const char *Path) {
    const char *Dot = Path ? strrchr(Path, '.') : NULL;
    if (!Dot) return "application/octet-stream";
    if (strcasecmp(Dot, ".png") == 0) return "image/png";
    if (strcasecmp(Dot, ".jpg") == 0 || strcasecmp(Dot, ".jpeg") == 0) return "image/jpeg";
    if (strcasecmp(Dot, ".gif") == 0) return "image/gif";
    if (strcasecmp(Dot, ".webp") == 0) return "image/webp";
    if (strcasecmp(Dot, ".svg") == 0) return "image/svg+xml";
    if (strcasecmp(Dot, ".bmp") == 0) return "image/bmp";
    if (strcasecmp(Dot, ".pdf") == 0) return "application/pdf";
    if (strcasecmp(Dot, ".txt") == 0) return "text/plain";
    return "application/octet-stream";
}

static const char *mlai_guess_mime_from_bytes(const unsigned char *B, size_t Len) {
    if (Len >= 8 && B[0] == 0x89 && B[1] == 'P' && B[2] == 'N' && B[3] == 'G') return "image/png";
    if (Len >= 3 && B[0] == 0xFF && B[1] == 0xD8 && B[2] == 0xFF) return "image/jpeg";
    if (Len >= 6 && memcmp(B, "GIF8", 4) == 0) return "image/gif";
    if (Len >= 12 && memcmp(B, "RIFF", 4) == 0 && memcmp(B + 8, "WEBP", 4) == 0) return "image/webp";
    if (Len >= 4 && memcmp(B, "%PDF", 4) == 0) return "application/pdf";
    return "image/png";
}

static ml_value_t *mlai_decode_json_response_text(const char *Text, size_t Len) {
    if (!Text) return MLNil;
    while (Len > 0 && isspace((unsigned char)*Text)) { Text++; Len--; }
    while (Len > 0 && isspace((unsigned char)Text[Len - 1])) { Len--; }
    /* Strip optional ```json ... ``` markdown code fences */
    if (Len >= 6 && strncmp(Text, "```", 3) == 0) {
        const char *Nl = memchr(Text, '\n', Len);
        if (Nl) {
            size_t Skip = (size_t)(Nl - Text) + 1;
            Text += Skip;
            Len -= Skip;
            if (Len >= 3 && strncmp(Text + Len - 3, "```", 3) == 0) {
                Len -= 3;
                while (Len > 0 && isspace((unsigned char)Text[Len - 1])) Len--;
            }
        }
    }
    return ml_json_decode(Text, Len);
}

/* ============================================================================
 * Part 1: `agy` Module (via local server `/api/agy/status` & `/api/agy/prompt`)
 * ============================================================================ */

static ml_value_t *mlai_agy_http(
    const char *Method,
    const char *Path,
    ml_value_t *BodyMap,
    long TimeoutSecs,
    long *OutStatus
) {
    const char *Base = getenv("MINILANG_INTERNAL_URL");
    if (!Base || !*Base) {
        return ml_error("AgyError", "agy server API is unavailable (MINILANG_INTERNAL_URL not set)");
    }
    size_t Blen = strlen(Base);
    while (Blen > 0 && Base[Blen - 1] == '/') Blen--;
    size_t UrlCap = Blen + strlen(Path) + 4;
    char *Url = (char *)malloc(UrlCap);
    if (!Url) return ml_error("AgyError", "Out of memory");
    snprintf(Url, UrlCap, "%.*s%s", (int)Blen, Base, Path);

    const char *Token = getenv("MINILANG_INTERNAL_TOKEN");
    char TokHdr[512];
    const char *Headers[3] = {NULL, NULL, NULL};
    int HIdx = 0;
    if (Token && *Token) {
        snprintf(TokHdr, sizeof(TokHdr), "X-Internal-Token: %s", Token);
        Headers[HIdx++] = TokHdr;
    }

    char *JsonBody = NULL;
    size_t BodyLen = 0;
    if (BodyMap) {
        ml_value_t *Err = mlai_json_encode_str(BodyMap, &JsonBody, &BodyLen);
        if (Err) {
            free(Url);
            return Err;
        }
    }

    long Status = 0;
    ml_value_t *Resp = mlio_http_json_raw(
        Method,
        Url,
        HIdx > 0 ? Headers : NULL,
        JsonBody,
        BodyLen,
        TimeoutSecs > 0 ? TimeoutSecs : 150L,
        &Status
    );
    free(JsonBody);
    free(Url);
    if (OutStatus) *OutStatus = Status;
    if (ml_is_error(Resp)) return Resp;

    if (Status >= 400) {
        const char *ErrMsg = NULL;
        if (ml_is(Resp, MLMapT)) {
            ml_value_t *E = ml_map_search(Resp, ml_cstring("error"));
            if (E && ml_is(ml_deref(E), MLStringT)) ErrMsg = ml_string_value(ml_deref(E));
            if (!ErrMsg) {
                ml_value_t *R = ml_map_search(Resp, ml_cstring("raw_text"));
                if (R && ml_is(ml_deref(R), MLStringT)) ErrMsg = ml_string_value(ml_deref(R));
            }
        }
        return ml_error("AgyError", "%s", (ErrMsg && *ErrMsg) ? ErrMsg : "agy request failed");
    }
    return Resp;
}

static ml_value_t *mlai_agy_prompt_impl(
    const char *Prompt,
    ml_value_t *Opts,
    int ForceFull,
    const char **OutConvId
) {
    if (OutConvId) *OutConvId = NULL;
    ml_value_t *Req = ml_map();
    ml_map_insert(Req, ml_cstring("prompt"), ml_string_copy(Prompt, (int)strlen(Prompt)));

    const char *Sys = mlai_opt_str(Opts, "system");
    if (Sys) ml_map_insert(Req, ml_cstring("system"), ml_string_copy(Sys, (int)strlen(Sys)));
    const char *Model = mlai_opt_str(Opts, "model");
    if (Model) ml_map_insert(Req, ml_cstring("model"), ml_string_copy(Model, (int)strlen(Model)));
    const char *Effort = mlai_opt_str(Opts, "effort");
    if (Effort) ml_map_insert(Req, ml_cstring("effort"), ml_string_copy(Effort, (int)strlen(Effort)));
    const char *Mode = mlai_opt_str(Opts, "mode");
    if (Mode) ml_map_insert(Req, ml_cstring("mode"), ml_string_copy(Mode, (int)strlen(Mode)));
    const char *ConvId = mlai_opt_str(Opts, "conversation_id");
    if (ConvId) ml_map_insert(Req, ml_cstring("conversation_id"), ml_string_copy(ConvId, (int)strlen(ConvId)));

    int64_t TimeoutSecs = 120;
    if (mlai_opt_int(Opts, "timeout", &TimeoutSecs) && TimeoutSecs > 0) {
        ml_map_insert(Req, ml_cstring("timeout_secs"), ml_integer(TimeoutSecs));
    } else if (mlai_opt_int(Opts, "timeout_secs", &TimeoutSecs) && TimeoutSecs > 0) {
        ml_map_insert(Req, ml_cstring("timeout_secs"), ml_integer(TimeoutSecs));
    }

    char Cwd[4096];
    if (getcwd(Cwd, sizeof(Cwd))) {
        ml_map_insert(Req, ml_cstring("cwd"), ml_string_copy(Cwd, (int)strlen(Cwd)));
    }

    long Status = 0;
    ml_value_t *Resp = mlai_agy_http("POST", "/api/agy/prompt", Req, (long)TimeoutSecs + 15L, &Status);
    if (ml_is_error(Resp)) return Resp;

    ml_value_t *TextVal = ml_string("", 0);
    ml_value_t *RespConv = MLNil;
    ml_value_t *SugCode = MLNil;
    ml_value_t *SugLang = MLNil;
    ml_value_t *DurMs = MLNil;

    if (ml_is(Resp, MLMapT)) {
        ml_value_t *V = ml_map_search(Resp, ml_cstring("response"));
        if (V && ml_is(ml_deref(V), MLStringT)) TextVal = ml_deref(V);
        V = ml_map_search(Resp, ml_cstring("conversation_id"));
        if (V) RespConv = ml_deref(V);
        V = ml_map_search(Resp, ml_cstring("suggested_code"));
        if (V) SugCode = ml_deref(V);
        V = ml_map_search(Resp, ml_cstring("suggested_lang"));
        if (V) SugLang = ml_deref(V);
        V = ml_map_search(Resp, ml_cstring("duration_ms"));
        if (V) DurMs = ml_deref(V);
    }

    if (OutConvId && ml_is(RespConv, MLStringT)) {
        *OutConvId = ml_string_value(RespConv);
    }

    int WantFull = ForceFull || mlai_opt_bool(Opts, "full", 0) || mlai_opt_bool(Opts, "raw", 0);
    int WantJson = mlai_opt_bool(Opts, "json", 0);

    if (WantFull) {
        ml_value_t *Out = ml_map();
        ml_map_insert(Out, ml_cstring("provider"), ml_cstring("agy"));
        ml_map_insert(Out, ml_cstring("text"), TextVal);
        ml_map_insert(Out, ml_cstring("conversation_id"), RespConv);
        ml_map_insert(Out, ml_cstring("suggested_code"), SugCode);
        ml_map_insert(Out, ml_cstring("suggested_lang"), SugLang);
        ml_map_insert(Out, ml_cstring("duration_ms"), DurMs);
        if (WantJson && ml_is(TextVal, MLStringT)) {
            ml_value_t *Parsed = mlai_decode_json_response_text(ml_string_value(TextVal), ml_string_length(TextVal));
            if (!ml_is_error(Parsed)) ml_map_insert(Out, ml_cstring("json"), Parsed);
        }
        return Out;
    }

    if (WantJson && ml_is(TextVal, MLStringT)) {
        return mlai_decode_json_response_text(ml_string_value(TextVal), ml_string_length(TextVal));
    }
    return TextVal;
}

static ml_value_t *mlai_agy_status_impl(void) {
    long Status = 0;
    ml_value_t *Resp = mlai_agy_http("GET", "/api/agy/status", NULL, 10L, &Status);
    if (ml_is_error(Resp)) {
        ml_value_t *Out = ml_map();
        ml_map_insert(Out, ml_cstring("available"), ml_boolean(0));
        ml_map_insert(Out, ml_cstring("bin"), MLNil);
        ml_map_insert(Out, ml_cstring("default_model"), MLNil);
        return Out;
    }
    return Resp;
}

ML_FUNCTION(MLAgyStatus) {
    return mlai_agy_status_impl();
}

static ml_value_t *mlai_agy_prompt_cb(void *Data, int Count, ml_value_t **Args) {
    int ForceFull = (Data != NULL);
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1 || !ml_is(Pos[0], MLStringT)) {
        return ml_error("TypeError", "agy::prompt expects a prompt string");
    }
    return mlai_agy_prompt_impl(ml_string_value(Pos[0]), Opts, ForceFull, NULL);
}

/* Format a list of chat messages into a prompt for agy */
static ml_value_t *mlai_agy_chat_messages(ml_value_t *Messages, ml_value_t *Opts, int ForceFull) {
    if (!ml_is(Messages, MLListT)) {
        return ml_error("TypeError", "agy::chat expects a list of message maps");
    }
    ml_stringbuffer_t Sb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_t SysSb[1] = {ML_STRINGBUFFER_INIT};
    const char *ExistingSys = mlai_opt_str(Opts, "system");
    if (ExistingSys) ml_stringbuffer_write(SysSb, ExistingSys, strlen(ExistingSys));

    ML_LIST_FOREACH(Messages, Node) {
        ml_value_t *M = ml_deref(Node->Value);
        if (ml_is(M, MLStringT)) {
            ml_stringbuffer_printf(Sb, "User: %s\n\n", ml_string_value(M));
            continue;
        }
        if (!ml_is(M, MLMapT)) continue;
        ml_value_t *RoleV = ml_map_search(M, ml_cstring("role"));
        const char *Role = (RoleV && ml_is(ml_deref(RoleV), MLStringT)) ? ml_string_value(ml_deref(RoleV)) : "user";
        ml_value_t *ContentV = ml_map_search(M, ml_cstring("content"));
        if (!ContentV) ContentV = ml_map_search(M, ml_cstring("text"));
        if (!ContentV || !ml_is(ml_deref(ContentV), MLStringT)) continue;
        const char *Txt = ml_string_value(ml_deref(ContentV));
        if (strcasecmp(Role, "system") == 0) {
            if (SysSb->Length > 0) ml_stringbuffer_write(SysSb, "\n", 1);
            ml_stringbuffer_write(SysSb, Txt, strlen(Txt));
        } else if (strcasecmp(Role, "assistant") == 0 || strcasecmp(Role, "model") == 0) {
            ml_stringbuffer_printf(Sb, "Assistant: %s\n\n", Txt);
        } else {
            ml_stringbuffer_printf(Sb, "User: %s\n\n", Txt);
        }
    }
    if (SysSb->Length > 0) {
        size_t SysLen = SysSb->Length;
        const char *S = ml_stringbuffer_get_string(SysSb);
        ml_map_insert(Opts, ml_cstring("system"), ml_string_copy(S, (int)SysLen));
    }
    const char *Prompt = ml_stringbuffer_get_string(Sb);
    return mlai_agy_prompt_impl(Prompt ? Prompt : "", Opts, ForceFull, NULL);
}

/* ============================================================================
 * Part 2: `gemini` Module (Google Gemini REST API via libcurl HTTPS)
 * ============================================================================ */

static ml_value_t *mlai_build_image_part(ml_value_t *Item) {
    Item = ml_deref(Item);
    if (!Item || Item == MLNil) return NULL;

    if (ml_is(Item, MLStringT)) {
        const char *Path = ml_string_value(Item);
        FILE *Fp = fopen(Path, "rb");
        if (!Fp) return ml_error("GeminiError", "Failed to open media file '%s'", Path);
        fseek(Fp, 0, SEEK_END);
        long Fsize = ftell(Fp);
        rewind(Fp);
        if (Fsize < 0 || Fsize > 32 * 1024 * 1024) {
            fclose(Fp);
            return ml_error("GeminiError", "Media file '%s' is empty or exceeds 32 MB limit", Path);
        }
        unsigned char *Buf = (unsigned char *)malloc((size_t)Fsize + 1);
        if (!Buf) {
            fclose(Fp);
            return ml_error("GeminiError", "Out of memory reading media file");
        }
        size_t ReadN = (Fsize > 0) ? fread(Buf, 1, (size_t)Fsize, Fp) : 0;
        fclose(Fp);
        const char *Mime = mlai_guess_mime_from_ext(Path);
        if (strcmp(Mime, "application/octet-stream") == 0) {
            Mime = mlai_guess_mime_from_bytes(Buf, ReadN);
        }
        ml_value_t *B64 = mlai_b64_encode(Buf, ReadN);
        free(Buf);

        ml_value_t *Inline = ml_map();
        ml_map_insert(Inline, ml_cstring("mimeType"), ml_string_copy(Mime, (int)strlen(Mime)));
        ml_map_insert(Inline, ml_cstring("data"), B64);
        ml_value_t *Part = ml_map();
        ml_map_insert(Part, ml_cstring("inlineData"), Inline);
        return Part;
    }

    if (ml_is(Item, MLAddressT)) {
        const unsigned char *Bytes = (const unsigned char *)ml_address_value(Item);
        size_t Len = (size_t)ml_address_length(Item);
        const char *Mime = mlai_guess_mime_from_bytes(Bytes, Len);
        ml_value_t *B64 = mlai_b64_encode(Bytes, Len);
        ml_value_t *Inline = ml_map();
        ml_map_insert(Inline, ml_cstring("mimeType"), ml_string_copy(Mime, (int)strlen(Mime)));
        ml_map_insert(Inline, ml_cstring("data"), B64);
        ml_value_t *Part = ml_map();
        ml_map_insert(Part, ml_cstring("inlineData"), Inline);
        return Part;
    }

    if (ml_is(Item, MLMapT)) {
        if (ml_map_search(Item, ml_cstring("inlineData")) || ml_map_search(Item, ml_cstring("text"))) {
            return Item;
        }
        ml_value_t *DataV = ml_map_search(Item, ml_cstring("data"));
        ml_value_t *MimeV = ml_map_search(Item, ml_cstring("mime_type"));
        if (!MimeV) MimeV = ml_map_search(Item, ml_cstring("mimeType"));
        const char *Mime = (MimeV && ml_is(ml_deref(MimeV), MLStringT))
            ? ml_string_value(ml_deref(MimeV))
            : "image/png";
        if (DataV) {
            DataV = ml_deref(DataV);
            ml_value_t *B64 = NULL;
            if (ml_is(DataV, MLAddressT)) {
                B64 = mlai_b64_encode((const unsigned char *)ml_address_value(DataV), (size_t)ml_address_length(DataV));
            } else if (ml_is(DataV, MLStringT)) {
                B64 = DataV;
            }
            if (B64) {
                ml_value_t *Inline = ml_map();
                ml_map_insert(Inline, ml_cstring("mimeType"), ml_string_copy(Mime, (int)strlen(Mime)));
                ml_map_insert(Inline, ml_cstring("data"), B64);
                ml_value_t *Part = ml_map();
                ml_map_insert(Part, ml_cstring("inlineData"), Inline);
                return Part;
            }
        }
    }

    return ml_error("TypeError", "Gemini image/media attachment must be a file path string, byte buffer, or map");
}

static ml_value_t *mlai_gemini_extract_error(ml_value_t *Resp, long Status) {
    if (Resp && ml_is(Resp, MLMapT)) {
        ml_value_t *ErrObj = ml_map_search(Resp, ml_cstring("error"));
        if (ErrObj && ml_is(ml_deref(ErrObj), MLMapT)) {
            ml_value_t *Msg = ml_map_search(ml_deref(ErrObj), ml_cstring("message"));
            if (Msg && ml_is(ml_deref(Msg), MLStringT)) {
                return ml_error("GeminiError", "Gemini API error (HTTP %ld): %s", Status, ml_string_value(ml_deref(Msg)));
            }
        }
        ml_value_t *Raw = ml_map_search(Resp, ml_cstring("raw_text"));
        if (Raw && ml_is(ml_deref(Raw), MLStringT)) {
            return ml_error("GeminiError", "Gemini API error (HTTP %ld): %s", Status, ml_string_value(ml_deref(Raw)));
        }
    }
    return ml_error("GeminiError", "Gemini API request failed with HTTP status %ld", Status);
}

static ml_value_t *mlai_gemini_generate_contents(
    ml_value_t *Contents,
    ml_value_t *Opts,
    int ForceFull
) {
    const char *ApiKey = mlai_resolve_gemini_key(Opts);
    if (!ApiKey || !*ApiKey) {
        return ml_error(
            "GeminiError",
            "Gemini API key not configured. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in Secrets Vault / env, or pass api_key is \"...\"."
        );
    }
    const char *Base = mlai_resolve_gemini_base(Opts);
    const char *Model = mlai_resolve_gemini_model(Opts, MLAI_DEFAULT_GEMINI_MODEL);
    if (strncmp(Model, "models/", 7) == 0) Model += 7;

    ml_value_t *Req = ml_map();
    ml_map_insert(Req, ml_cstring("contents"), Contents);

    const char *Sys = mlai_opt_str(Opts, "system");
    if (Sys) {
        ml_value_t *Part = ml_map();
        ml_map_insert(Part, ml_cstring("text"), ml_string_copy(Sys, (int)strlen(Sys)));
        ml_value_t *Parts = ml_list();
        ml_list_put(Parts, Part);
        ml_value_t *SysObj = ml_map();
        ml_map_insert(SysObj, ml_cstring("parts"), Parts);
        ml_map_insert(Req, ml_cstring("systemInstruction"), SysObj);
    }

    ml_value_t *GenCfg = ml_map();
    int HasGenCfg = 0;
    double Num = 0.0;
    int64_t IntV = 0;
    if (mlai_opt_number(Opts, "temperature", &Num)) {
        ml_map_insert(GenCfg, ml_cstring("temperature"), ml_real(Num));
        HasGenCfg = 1;
    }
    if (mlai_opt_number(Opts, "top_p", &Num)) {
        ml_map_insert(GenCfg, ml_cstring("topP"), ml_real(Num));
        HasGenCfg = 1;
    }
    if (mlai_opt_int(Opts, "top_k", &IntV)) {
        ml_map_insert(GenCfg, ml_cstring("topK"), ml_integer(IntV));
        HasGenCfg = 1;
    }
    if (mlai_opt_int(Opts, "max_tokens", &IntV) || mlai_opt_int(Opts, "max_output_tokens", &IntV)) {
        ml_map_insert(GenCfg, ml_cstring("maxOutputTokens"), ml_integer(IntV));
        HasGenCfg = 1;
    }
    int WantJson = mlai_opt_bool(Opts, "json", 0);
    const char *Mime = mlai_opt_str(Opts, "response_mime_type");
    if (Mime) {
        ml_map_insert(GenCfg, ml_cstring("responseMimeType"), ml_string_copy(Mime, (int)strlen(Mime)));
        HasGenCfg = 1;
    } else if (WantJson) {
        ml_map_insert(GenCfg, ml_cstring("responseMimeType"), ml_cstring("application/json"));
        HasGenCfg = 1;
    }
    ml_value_t *Schema = Opts ? ml_map_search(Opts, ml_cstring("response_schema")) : NULL;
    if (Schema && ml_deref(Schema) != MLNil) {
        ml_map_insert(GenCfg, ml_cstring("responseSchema"), ml_deref(Schema));
        if (!Mime && !WantJson) {
            ml_map_insert(GenCfg, ml_cstring("responseMimeType"), ml_cstring("application/json"));
        }
        HasGenCfg = 1;
    }
    if (HasGenCfg) {
        ml_map_insert(Req, ml_cstring("generationConfig"), GenCfg);
    }

    size_t Blen = strlen(Base);
    while (Blen > 0 && Base[Blen - 1] == '/') Blen--;
    size_t UrlCap = Blen + strlen(Model) + 64;
    char *Url = (char *)malloc(UrlCap);
    if (!Url) return ml_error("GeminiError", "Out of memory");
    snprintf(Url, UrlCap, "%.*s/models/%s:generateContent", (int)Blen, Base, Model);

    char *KeyHdr = (char *)malloc(strlen(ApiKey) + 32);
    if (!KeyHdr) {
        free(Url);
        return ml_error("GeminiError", "Out of memory");
    }
    snprintf(KeyHdr, strlen(ApiKey) + 32, "x-goog-api-key: %s", ApiKey);
    const char *Headers[2] = {KeyHdr, NULL};

    char *JsonBody = NULL;
    size_t BodyLen = 0;
    ml_value_t *EncErr = mlai_json_encode_str(Req, &JsonBody, &BodyLen);
    if (EncErr) {
        free(KeyHdr);
        free(Url);
        return EncErr;
    }

    int64_t TimeoutSecs = 90;
    if (!mlai_opt_int(Opts, "timeout", &TimeoutSecs) || TimeoutSecs <= 0) TimeoutSecs = 90;

    long Status = 0;
    ml_value_t *Resp = mlio_http_json_raw("POST", Url, Headers, JsonBody, BodyLen, (long)TimeoutSecs, &Status);
    free(JsonBody);
    free(KeyHdr);
    free(Url);

    if (ml_is_error(Resp)) return Resp;
    if (Status >= 400) return mlai_gemini_extract_error(Resp, Status);

    /* Extract text from candidates[0].content.parts */
    ml_stringbuffer_t TextSb[1] = {ML_STRINGBUFFER_INIT};
    ml_stringbuffer_t AllSb[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *FinishReason = MLNil;
    ml_value_t *Usage = MLNil;

    if (ml_is(Resp, MLMapT)) {
        ml_value_t *U = ml_map_search(Resp, ml_cstring("usageMetadata"));
        if (U) Usage = ml_deref(U);

        ml_value_t *Cands = ml_map_search(Resp, ml_cstring("candidates"));
        if (Cands && ml_is(ml_deref(Cands), MLListT) && ml_list_length(ml_deref(Cands)) > 0) {
            ml_value_t *First = ml_deref(ml_list_get(ml_deref(Cands), 1));
            if (ml_is(First, MLMapT)) {
                ml_value_t *Fr = ml_map_search(First, ml_cstring("finishReason"));
                if (Fr) FinishReason = ml_deref(Fr);
                ml_value_t *Content = ml_map_search(First, ml_cstring("content"));
                if (Content && ml_is(ml_deref(Content), MLMapT)) {
                    ml_value_t *Parts = ml_map_search(ml_deref(Content), ml_cstring("parts"));
                    if (Parts && ml_is(ml_deref(Parts), MLListT)) {
                        ML_LIST_FOREACH(ml_deref(Parts), PNode) {
                            ml_value_t *Part = ml_deref(PNode->Value);
                            if (!ml_is(Part, MLMapT)) continue;
                            ml_value_t *TxtV = ml_map_search(Part, ml_cstring("text"));
                            if (!TxtV || !ml_is(ml_deref(TxtV), MLStringT)) continue;
                            const char *Ts = ml_string_value(ml_deref(TxtV));
                            size_t Tl = ml_string_length(ml_deref(TxtV));
                            ml_stringbuffer_write(AllSb, Ts, Tl);
                            ml_value_t *Thought = ml_map_search(Part, ml_cstring("thought"));
                            int IsThought = (Thought && ml_is(ml_deref(Thought), MLBooleanT) && ml_boolean_value(ml_deref(Thought)));
                            if (!IsThought) {
                                ml_stringbuffer_write(TextSb, Ts, Tl);
                            }
                        }
                    }
                }
            }
        }
    }

    ml_stringbuffer_t *ChosenSb = (TextSb->Length > 0) ? TextSb : AllSb;
    size_t FinalLen = ChosenSb->Length;
    const char *FinalStr = ml_stringbuffer_get_string(ChosenSb);
    ml_value_t *TextVal = (FinalLen > 0 && FinalStr) ? ml_string_copy(FinalStr, (int)FinalLen) : ml_string("", 0);

    int WantFull = ForceFull || mlai_opt_bool(Opts, "full", 0) || mlai_opt_bool(Opts, "raw", 0);
    if (WantFull) {
        ml_value_t *Out = ml_map();
        ml_map_insert(Out, ml_cstring("provider"), ml_cstring("gemini"));
        ml_map_insert(Out, ml_cstring("model"), ml_string_copy(Model, (int)strlen(Model)));
        ml_map_insert(Out, ml_cstring("text"), TextVal);
        ml_map_insert(Out, ml_cstring("finish_reason"), FinishReason);
        ml_map_insert(Out, ml_cstring("usage"), Usage);
        ml_map_insert(Out, ml_cstring("raw"), Resp);
        if (WantJson) {
            ml_value_t *Parsed = mlai_decode_json_response_text(ml_string_value(TextVal), ml_string_length(TextVal));
            if (!ml_is_error(Parsed)) ml_map_insert(Out, ml_cstring("json"), Parsed);
        }
        return Out;
    }

    if (WantJson) {
        return mlai_decode_json_response_text(ml_string_value(TextVal), ml_string_length(TextVal));
    }
    return TextVal;
}

static ml_value_t *mlai_gemini_prompt_impl(ml_value_t *PromptVal, ml_value_t *Opts, int ForceFull) {
    ml_value_t *Parts = ml_list();
    if (ml_is(PromptVal, MLStringT)) {
        ml_value_t *P = ml_map();
        ml_map_insert(P, ml_cstring("text"), PromptVal);
        ml_list_put(Parts, P);
    } else if (ml_is(PromptVal, MLListT)) {
        ML_LIST_FOREACH(PromptVal, Node) {
            ml_value_t *Item = ml_deref(Node->Value);
            if (ml_is(Item, MLStringT)) {
                ml_value_t *P = ml_map();
                ml_map_insert(P, ml_cstring("text"), Item);
                ml_list_put(Parts, P);
            } else {
                ml_value_t *Part = mlai_build_image_part(Item);
                if (ml_is_error(Part)) return Part;
                if (Part) ml_list_put(Parts, Part);
            }
        }
    } else {
        return ml_error("TypeError", "gemini::prompt expects a prompt string or list of parts");
    }

    /* Optional `image := ...` or `images := [...]` attachment(s) */
    ml_value_t *SingleImg = Opts ? ml_map_search(Opts, ml_cstring("image")) : NULL;
    if (SingleImg && ml_deref(SingleImg) != MLNil) {
        ml_value_t *Part = mlai_build_image_part(SingleImg);
        if (ml_is_error(Part)) return Part;
        if (Part) ml_list_put(Parts, Part);
    }
    ml_value_t *MultiImg = Opts ? ml_map_search(Opts, ml_cstring("images")) : NULL;
    if (MultiImg && ml_is(ml_deref(MultiImg), MLListT)) {
        ML_LIST_FOREACH(ml_deref(MultiImg), Node) {
            ml_value_t *Part = mlai_build_image_part(Node->Value);
            if (ml_is_error(Part)) return Part;
            if (Part) ml_list_put(Parts, Part);
        }
    }

    ml_value_t *Turn = ml_map();
    ml_map_insert(Turn, ml_cstring("role"), ml_cstring("user"));
    ml_map_insert(Turn, ml_cstring("parts"), Parts);
    ml_value_t *Contents = ml_list();
    ml_list_put(Contents, Turn);

    return mlai_gemini_generate_contents(Contents, Opts, ForceFull);
}

static ml_value_t *mlai_gemini_chat_impl(ml_value_t *Messages, ml_value_t *Opts, int ForceFull) {
    if (!ml_is(Messages, MLListT)) {
        return ml_error("TypeError", "gemini::chat expects a list of message maps");
    }
    ml_value_t *Contents = ml_list();
    ml_stringbuffer_t SysSb[1] = {ML_STRINGBUFFER_INIT};
    const char *ExistingSys = mlai_opt_str(Opts, "system");
    if (ExistingSys) ml_stringbuffer_write(SysSb, ExistingSys, strlen(ExistingSys));

    ML_LIST_FOREACH(Messages, Node) {
        ml_value_t *M = ml_deref(Node->Value);
        if (ml_is(M, MLStringT)) {
            ml_value_t *P = ml_map();
            ml_map_insert(P, ml_cstring("text"), M);
            ml_value_t *Parts = ml_list();
            ml_list_put(Parts, P);
            ml_value_t *Turn = ml_map();
            ml_map_insert(Turn, ml_cstring("role"), ml_cstring("user"));
            ml_map_insert(Turn, ml_cstring("parts"), Parts);
            ml_list_put(Contents, Turn);
            continue;
        }
        if (!ml_is(M, MLMapT)) continue;
        ml_value_t *RoleV = ml_map_search(M, ml_cstring("role"));
        const char *Role = (RoleV && ml_is(ml_deref(RoleV), MLStringT)) ? ml_string_value(ml_deref(RoleV)) : "user";
        ml_value_t *ContentV = ml_map_search(M, ml_cstring("content"));
        if (!ContentV) ContentV = ml_map_search(M, ml_cstring("text"));
        ml_value_t *PartsV = ml_map_search(M, ml_cstring("parts"));

        if (strcasecmp(Role, "system") == 0) {
            if (ContentV && ml_is(ml_deref(ContentV), MLStringT)) {
                if (SysSb->Length > 0) ml_stringbuffer_write(SysSb, "\n", 1);
                const char *S = ml_string_value(ml_deref(ContentV));
                ml_stringbuffer_write(SysSb, S, strlen(S));
            }
            continue;
        }

        const char *GemRole = (strcasecmp(Role, "assistant") == 0 || strcasecmp(Role, "model") == 0)
            ? "model"
            : "user";

        ml_value_t *Parts = ml_list();
        if (PartsV && ml_is(ml_deref(PartsV), MLListT)) {
            Parts = ml_deref(PartsV);
        } else if (ContentV && ml_is(ml_deref(ContentV), MLStringT)) {
            ml_value_t *P = ml_map();
            ml_map_insert(P, ml_cstring("text"), ml_deref(ContentV));
            ml_list_put(Parts, P);
        }
        ml_value_t *Turn = ml_map();
        ml_map_insert(Turn, ml_cstring("role"), ml_string(GemRole, -1));
        ml_map_insert(Turn, ml_cstring("parts"), Parts);
        ml_list_put(Contents, Turn);
    }

    if (SysSb->Length > 0) {
        size_t SysLen = SysSb->Length;
        const char *S = ml_stringbuffer_get_string(SysSb);
        ml_map_insert(Opts, ml_cstring("system"), ml_string_copy(S, (int)SysLen));
    }

    return mlai_gemini_generate_contents(Contents, Opts, ForceFull);
}

static ml_value_t *mlai_gemini_status_impl(ml_value_t *Opts) {
    const char *Key = mlai_resolve_gemini_key(Opts);
    const char *Base = mlai_resolve_gemini_base(Opts);
    const char *Model = mlai_resolve_gemini_model(Opts, MLAI_DEFAULT_GEMINI_MODEL);
    ml_value_t *Out = ml_map();
    ml_map_insert(Out, ml_cstring("configured"), ml_boolean(Key && *Key));
    ml_map_insert(Out, ml_cstring("default_model"), ml_string_copy(Model, (int)strlen(Model)));
    ml_map_insert(Out, ml_cstring("base_url"), ml_string_copy(Base, (int)strlen(Base)));
    return Out;
}

ML_FUNCTION(MLGeminiStatus) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 0, Pos, &PosCount, NULL);
    return mlai_gemini_status_impl(Opts);
}

static ml_value_t *mlai_gemini_prompt_cb(void *Data, int Count, ml_value_t **Args) {
    int ForceFull = (Data != NULL);
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        return ml_error("CallError", "gemini::prompt requires a prompt string or parts list");
    }
    return mlai_gemini_prompt_impl(Pos[0], Opts, ForceFull);
}

ML_FUNCTION(MLGeminiChat) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        return ml_error("CallError", "gemini::chat requires a list of messages");
    }
    return mlai_gemini_chat_impl(Pos[0], Opts, 0);
}

static ml_value_t *mlai_gemini_embed_one(const char *Text, ml_value_t *Opts) {
    const char *ApiKey = mlai_resolve_gemini_key(Opts);
    if (!ApiKey || !*ApiKey) {
        return ml_error("GeminiError", "Gemini API key not configured for gemini::embed()");
    }
    const char *Base = mlai_resolve_gemini_base(Opts);
    const char *Model = mlai_resolve_gemini_model(Opts, MLAI_DEFAULT_EMBED_MODEL);
    if (strncmp(Model, "models/", 7) == 0) Model += 7;

    char ModelRef[256];
    snprintf(ModelRef, sizeof(ModelRef), "models/%s", Model);

    ml_value_t *Part = ml_map();
    ml_map_insert(Part, ml_cstring("text"), ml_string_copy(Text, (int)strlen(Text)));
    ml_value_t *Parts = ml_list();
    ml_list_put(Parts, Part);
    ml_value_t *Content = ml_map();
    ml_map_insert(Content, ml_cstring("parts"), Parts);

    ml_value_t *Req = ml_map();
    ml_map_insert(Req, ml_cstring("model"), ml_string_copy(ModelRef, (int)strlen(ModelRef)));
    ml_map_insert(Req, ml_cstring("content"), Content);

    const char *TaskType = mlai_opt_str(Opts, "task_type");
    if (TaskType) ml_map_insert(Req, ml_cstring("taskType"), ml_string_copy(TaskType, (int)strlen(TaskType)));
    int64_t Dims = 0;
    if (mlai_opt_int(Opts, "dimensions", &Dims) && Dims > 0) {
        ml_map_insert(Req, ml_cstring("outputDimensionality"), ml_integer(Dims));
    }

    size_t Blen = strlen(Base);
    while (Blen > 0 && Base[Blen - 1] == '/') Blen--;
    size_t UrlCap = Blen + strlen(Model) + 64;
    char *Url = (char *)malloc(UrlCap);
    if (!Url) return ml_error("GeminiError", "Out of memory");
    snprintf(Url, UrlCap, "%.*s/models/%s:embedContent", (int)Blen, Base, Model);

    char *KeyHdr = (char *)malloc(strlen(ApiKey) + 32);
    if (!KeyHdr) {
        free(Url);
        return ml_error("GeminiError", "Out of memory");
    }
    snprintf(KeyHdr, strlen(ApiKey) + 32, "x-goog-api-key: %s", ApiKey);
    const char *Headers[2] = {KeyHdr, NULL};

    char *JsonBody = NULL;
    size_t BodyLen = 0;
    ml_value_t *EncErr = mlai_json_encode_str(Req, &JsonBody, &BodyLen);
    if (EncErr) {
        free(KeyHdr);
        free(Url);
        return EncErr;
    }

    long Status = 0;
    ml_value_t *Resp = mlio_http_json_raw("POST", Url, Headers, JsonBody, BodyLen, 60L, &Status);
    free(JsonBody);
    free(KeyHdr);
    free(Url);
    if (ml_is_error(Resp)) return Resp;
    if (Status >= 400) return mlai_gemini_extract_error(Resp, Status);

    ml_value_t *Values = ml_list();
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Emb = ml_map_search(Resp, ml_cstring("embedding"));
        if (Emb && ml_is(ml_deref(Emb), MLMapT)) {
            ml_value_t *V = ml_map_search(ml_deref(Emb), ml_cstring("values"));
            if (V && ml_is(ml_deref(V), MLListT)) Values = ml_deref(V);
        }
    }
    if (mlai_opt_bool(Opts, "full", 0) || mlai_opt_bool(Opts, "raw", 0)) {
        ml_value_t *Out = ml_map();
        ml_map_insert(Out, ml_cstring("model"), ml_string_copy(Model, (int)strlen(Model)));
        ml_map_insert(Out, ml_cstring("values"), Values);
        ml_map_insert(Out, ml_cstring("raw"), Resp);
        return Out;
    }
    return Values;
}

ML_FUNCTION(MLGeminiEmbed) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        return ml_error("CallError", "gemini::embed requires a string or list of strings");
    }
    if (ml_is(Pos[0], MLStringT)) {
        return mlai_gemini_embed_one(ml_string_value(Pos[0]), Opts);
    }
    if (ml_is(Pos[0], MLListT)) {
        ml_value_t *Out = ml_list();
        ML_LIST_FOREACH(Pos[0], Node) {
            ml_value_t *Item = ml_deref(Node->Value);
            if (!ml_is(Item, MLStringT)) {
                return ml_error("TypeError", "gemini::embed list items must be strings");
            }
            ml_value_t *Vec = mlai_gemini_embed_one(ml_string_value(Item), Opts);
            if (ml_is_error(Vec)) return Vec;
            ml_list_put(Out, Vec);
        }
        return Out;
    }
    return ml_error("TypeError", "gemini::embed expects a string or list of strings");
}

ML_FUNCTION(MLGeminiModels) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 0, Pos, &PosCount, NULL);
    const char *ApiKey = mlai_resolve_gemini_key(Opts);
    if (!ApiKey || !*ApiKey) {
        return ml_error("GeminiError", "Gemini API key not configured for gemini::models()");
    }
    const char *Base = mlai_resolve_gemini_base(Opts);
    size_t Blen = strlen(Base);
    while (Blen > 0 && Base[Blen - 1] == '/') Blen--;
    size_t UrlCap = Blen + 32;
    char *Url = (char *)malloc(UrlCap);
    if (!Url) return ml_error("GeminiError", "Out of memory");
    snprintf(Url, UrlCap, "%.*s/models", (int)Blen, Base);

    char *KeyHdr = (char *)malloc(strlen(ApiKey) + 32);
    if (!KeyHdr) {
        free(Url);
        return ml_error("GeminiError", "Out of memory");
    }
    snprintf(KeyHdr, strlen(ApiKey) + 32, "x-goog-api-key: %s", ApiKey);
    const char *Headers[2] = {KeyHdr, NULL};

    long Status = 0;
    ml_value_t *Resp = mlio_http_json_raw("GET", Url, Headers, NULL, 0, 30L, &Status);
    free(KeyHdr);
    free(Url);
    if (ml_is_error(Resp)) return Resp;
    if (Status >= 400) return mlai_gemini_extract_error(Resp, Status);

    if (mlai_opt_bool(Opts, "full", 0) || mlai_opt_bool(Opts, "raw", 0)) {
        return Resp;
    }
    if (ml_is(Resp, MLMapT)) {
        ml_value_t *Models = ml_map_search(Resp, ml_cstring("models"));
        if (Models) return ml_deref(Models);
    }
    return Resp;
}

/* ============================================================================
 * Part 3: Stateful `ai::session` Type (works seamlessly for `agy` & `gemini`)
 * ============================================================================ */

typedef struct {
    ml_type_t *Type;
    const char *Provider;   /* "agy" or "gemini" */
    ml_value_t *Defaults;   /* MLMapT */
    ml_value_t *History;    /* MLListT of {"role", "text"} maps */
    const char *ConvId;     /* For agy --conversation threading */
} ml_ai_session_t;

static ml_value_t *mlai_session_ask_impl(
    ml_ai_session_t *Sess,
    ml_value_t *PromptVal,
    ml_value_t *CallOpts,
    int ForceFull
) {
    ml_value_t *Merged = ml_map();
    mlai_merge_map(Merged, Sess->Defaults);
    mlai_merge_map(Merged, CallOpts);

    if (strcmp(Sess->Provider, "agy") == 0) {
        if (!ml_is(PromptVal, MLStringT)) {
            return ml_error("TypeError", "agy session prompt must be a string");
        }
        if (Sess->ConvId && !mlai_opt_str(Merged, "conversation_id")) {
            ml_map_insert(Merged, ml_cstring("conversation_id"), ml_string_copy(Sess->ConvId, (int)strlen(Sess->ConvId)));
        }
        const char *NewConv = NULL;
        ml_value_t *Res = mlai_agy_prompt_impl(ml_string_value(PromptVal), Merged, ForceFull, &NewConv);
        if (ml_is_error(Res)) return Res;
        if (NewConv && *NewConv) {
            size_t L = strlen(NewConv);
            char *Copy = snew(L + 1);
            memcpy(Copy, NewConv, L + 1);
            Sess->ConvId = Copy;
        }

        ml_value_t *UserTurn = ml_map();
        ml_map_insert(UserTurn, ml_cstring("role"), ml_cstring("user"));
        ml_map_insert(UserTurn, ml_cstring("text"), PromptVal);
        ml_list_put(Sess->History, UserTurn);

        ml_value_t *ModelText = Res;
        if (ml_is(Res, MLMapT)) {
            ml_value_t *T = ml_map_search(Res, ml_cstring("text"));
            if (T) ModelText = ml_deref(T);
        }
        ml_value_t *ModelTurn = ml_map();
        ml_map_insert(ModelTurn, ml_cstring("role"), ml_cstring("model"));
        ml_map_insert(ModelTurn, ml_cstring("text"), ModelText);
        ml_list_put(Sess->History, ModelTurn);
        return Res;
    }

    /* Gemini multi-turn session */
    ml_value_t *Messages = ml_list();
    ML_LIST_FOREACH(Sess->History, Node) {
        ml_list_put(Messages, Node->Value);
    }
    ml_value_t *UserTurn = ml_map();
    ml_map_insert(UserTurn, ml_cstring("role"), ml_cstring("user"));
    if (ml_is(PromptVal, MLStringT)) {
        ml_map_insert(UserTurn, ml_cstring("text"), PromptVal);
    } else {
        return ml_error("TypeError", "gemini session prompt must be a string");
    }
    ml_list_put(Messages, UserTurn);

    ml_value_t *Res = mlai_gemini_chat_impl(Messages, Merged, ForceFull);
    if (ml_is_error(Res)) return Res;

    ml_list_put(Sess->History, UserTurn);
    ml_value_t *ModelText = Res;
    if (ml_is(Res, MLMapT)) {
        ml_value_t *T = ml_map_search(Res, ml_cstring("text"));
        if (T) ModelText = ml_deref(T);
    }
    ml_value_t *ModelTurn = ml_map();
    ml_map_insert(ModelTurn, ml_cstring("role"), ml_cstring("model"));
    ml_map_insert(ModelTurn, ml_cstring("text"), ModelText);
    ml_list_put(Sess->History, ModelTurn);
    return Res;
}

static void mlai_session_call(ml_state_t *Caller, ml_ai_session_t *Sess, int Count, ml_value_t **Args) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        ML_ERROR("CallError", "ai::session call requires a prompt string");
    }
    ML_RETURN(mlai_session_ask_impl(Sess, Pos[0], Opts, 0));
}

ML_TYPE(MLAiSessionT, (MLFunctionT), "ai::session",
    .call = (void *)mlai_session_call
);

static ml_ai_session_t *mlai_session_new(const char *Provider, ml_value_t *Opts) {
    ml_ai_session_t *S = new(ml_ai_session_t);
    S->Type = MLAiSessionT;
    S->Provider = (strcmp(Provider, "agy") == 0) ? "agy" : "gemini";
    S->Defaults = ml_map();
    if (Opts) mlai_merge_map(S->Defaults, Opts);
    S->History = ml_list();
    const char *Conv = mlai_opt_str(S->Defaults, "conversation_id");
    if (Conv) {
        size_t L = strlen(Conv);
        char *Copy = snew(L + 1);
        memcpy(Copy, Conv, L + 1);
        S->ConvId = Copy;
    } else {
        S->ConvId = NULL;
    }
    return S;
}

static ml_value_t *mlai_sess_m_ask(void *Data, int Count, ml_value_t **Args) {
    int ForceFull = (Data != NULL);
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[0];
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 1, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        return ml_error("CallError", "session:ask requires a prompt string");
    }
    return mlai_session_ask_impl(Sess, Pos[0], Opts, ForceFull);
}

static ml_value_t *mlai_sess_m_history(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[0];
    return Sess->History;
}

static ml_value_t *mlai_sess_m_provider(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[0];
    return ml_string(Sess->Provider, -1);
}

static ml_value_t *mlai_sess_m_model(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[0];
    const char *M = mlai_opt_str(Sess->Defaults, "model");
    if (M) return ml_string_copy(M, (int)strlen(M));
    if (strcmp(Sess->Provider, "gemini") == 0) {
        const char *Def = mlai_resolve_gemini_model(Sess->Defaults, MLAI_DEFAULT_GEMINI_MODEL);
        return ml_string_copy(Def, (int)strlen(Def));
    }
    return MLNil;
}

static ml_value_t *mlai_sess_m_conv_id(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[0];
    return Sess->ConvId ? ml_string_copy(Sess->ConvId, (int)strlen(Sess->ConvId)) : MLNil;
}

static ml_value_t *mlai_sess_m_clear(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[0];
    Sess->History = ml_list();
    Sess->ConvId = NULL;
    return (ml_value_t *)Sess;
}

static ml_value_t *mlai_sess_m_sb_append(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_stringbuffer_t *Sb = (ml_stringbuffer_t *)Args[0];
    ml_ai_session_t *Sess = (ml_ai_session_t *)Args[1];
    int Turns = ml_list_length(Sess->History) / 2;
    ml_stringbuffer_printf(Sb, "<ai::session %s (%d turns)>", Sess->Provider, Turns);
    return MLSome;
}

ML_FUNCTION(MLAgySession) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 0, Pos, &PosCount, NULL);
    return (ml_value_t *)mlai_session_new("agy", Opts);
}

ML_FUNCTION(MLAgyChat) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount >= 1 && ml_is(Pos[0], MLListT)) {
        return mlai_agy_chat_messages(Pos[0], Opts, 0);
    }
    return (ml_value_t *)mlai_session_new("agy", Opts);
}

ML_FUNCTION(MLGeminiSession) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 0, Pos, &PosCount, NULL);
    return (ml_value_t *)mlai_session_new("gemini", Opts);
}

/* ============================================================================
 * Part 4: Unified `ai` Module (`ai::prompt`, `ai::chat`, `ai::session`, `ai::status`)
 * ============================================================================ */

static const char *mlai_pick_provider(ml_value_t *Opts) {
    const char *P = mlai_opt_str(Opts, "provider");
    if (P) {
        if (strcasecmp(P, "agy") == 0 || strcasecmp(P, "antigravity") == 0) return "agy";
        if (strcasecmp(P, "gemini") == 0 || strcasecmp(P, "google") == 0) return "gemini";
        return P;
    }
    if (mlai_resolve_gemini_key(Opts) != NULL) return "gemini";
    return "agy";
}

static ml_value_t *mlai_ai_prompt_cb(void *Data, int Count, ml_value_t **Args) {
    int ForceFull = (Data != NULL);
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        return ml_error("CallError", "ai::prompt requires a prompt string");
    }
    const char *Prov = mlai_pick_provider(Opts);
    if (strcmp(Prov, "agy") == 0) {
        if (!ml_is(Pos[0], MLStringT)) {
            return ml_error("TypeError", "agy prompt must be a string");
        }
        return mlai_agy_prompt_impl(ml_string_value(Pos[0]), Opts, ForceFull, NULL);
    }
    if (strcmp(Prov, "gemini") == 0) {
        return mlai_gemini_prompt_impl(Pos[0], Opts, ForceFull);
    }
    return ml_error("ValueError", "Unknown AI provider '%s' (expected \"agy\" or \"gemini\")", Prov);
}

ML_FUNCTION(MLAiChat) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount < 1) {
        return ml_error("CallError", "ai::chat requires a list of messages");
    }
    const char *Prov = mlai_pick_provider(Opts);
    if (strcmp(Prov, "agy") == 0) {
        return mlai_agy_chat_messages(Pos[0], Opts, 0);
    }
    if (strcmp(Prov, "gemini") == 0) {
        return mlai_gemini_chat_impl(Pos[0], Opts, 0);
    }
    return ml_error("ValueError", "Unknown AI provider '%s' (expected \"agy\" or \"gemini\")", Prov);
}

ML_FUNCTION(MLAiSession) {
    ml_value_t *Pos[8];
    int PosCount = 0;
    ml_value_t *Opts = mlai_parse_args(Count, Args, 0, 1, Pos, &PosCount, NULL);
    if (PosCount >= 1 && ml_is(Pos[0], MLStringT)) {
        ml_map_insert(Opts, ml_cstring("provider"), Pos[0]);
    }
    const char *Prov = mlai_pick_provider(Opts);
    if (strcmp(Prov, "agy") != 0 && strcmp(Prov, "gemini") != 0) {
        return ml_error("ValueError", "Unknown AI provider '%s' (expected \"agy\" or \"gemini\")", Prov);
    }
    return (ml_value_t *)mlai_session_new(Prov, Opts);
}

ML_FUNCTION(MLAiStatus) {
    ml_value_t *Out = ml_map();
    ml_map_insert(Out, ml_cstring("agy"), mlai_agy_status_impl());
    ml_map_insert(Out, ml_cstring("gemini"), mlai_gemini_status_impl(NULL));
    return Out;
}

/* ============================================================================
 * Module Registration
 * ============================================================================ */

void ml_ai_init(stringmap_t *Globals) {
    ml_type_init(MLAiSessionT, MLFunctionT, NULL);

    ml_value_t *SessAskFn = ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_ask);
    ml_value_t *SessCompFn = ml_cfunction((void *)1, (ml_callback_t)mlai_sess_m_ask);
    ml_method_definev(ml_method("ask"), SessAskFn, MLAnyT, MLAiSessionT, MLAnyT, NULL);
    ml_method_definev(ml_method("prompt"), SessAskFn, MLAnyT, MLAiSessionT, MLAnyT, NULL);
    ml_method_definev(ml_method("complete"), SessCompFn, MLAnyT, MLAiSessionT, MLAnyT, NULL);
    ml_method_definev(ml_method("history"), ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_history), NULL, MLAiSessionT, NULL);
    ml_method_definev(ml_method("provider"), ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_provider), NULL, MLAiSessionT, NULL);
    ml_method_definev(ml_method("model"), ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_model), NULL, MLAiSessionT, NULL);
    ml_method_definev(ml_method("conversation_id"), ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_conv_id), NULL, MLAiSessionT, NULL);
    ml_method_definev(ml_method("clear"), ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_clear), NULL, MLAiSessionT, NULL);
    ml_method_definev(
        ml_method("append"),
        ml_cfunction(NULL, (ml_callback_t)mlai_sess_m_sb_append),
        NULL,
        MLStringBufferT,
        MLAiSessionT,
        NULL
    );

    ml_value_t *AgyPromptFn = ml_cfunction(NULL, mlai_agy_prompt_cb);
    ml_value_t *AgyCompleteFn = ml_cfunction((void *)1, mlai_agy_prompt_cb);

    ml_value_t *AgyMod = ml_module("agy",
        "prompt",   AgyPromptFn,
        "ask",      AgyPromptFn,
        "run",      AgyPromptFn,
        "complete", AgyCompleteFn,
        "chat",     MLAgyChat,
        "session",  MLAgySession,
        "status",   MLAgyStatus,
        NULL
    );

    ml_value_t *GemPromptFn = ml_cfunction(NULL, mlai_gemini_prompt_cb);
    ml_value_t *GemCompleteFn = ml_cfunction((void *)1, mlai_gemini_prompt_cb);

    ml_value_t *GeminiMod = ml_module("gemini",
        "prompt",   GemPromptFn,
        "ask",      GemPromptFn,
        "generate", GemPromptFn,
        "complete", GemCompleteFn,
        "chat",     MLGeminiChat,
        "session",  MLGeminiSession,
        "embed",    MLGeminiEmbed,
        "models",   MLGeminiModels,
        "status",   MLGeminiStatus,
        NULL
    );

    ml_value_t *AiPromptFn = ml_cfunction(NULL, mlai_ai_prompt_cb);
    ml_value_t *AiCompleteFn = ml_cfunction((void *)1, mlai_ai_prompt_cb);

    ml_value_t *AiMod = ml_module("ai",
        "agy",      AgyMod,
        "gemini",   GeminiMod,
        "prompt",   AiPromptFn,
        "ask",      AiPromptFn,
        "complete", AiCompleteFn,
        "chat",     MLAiChat,
        "session",  MLAiSession,
        "status",   MLAiStatus,
        NULL
    );

    stringmap_insert(Globals, "ai", AiMod);
    stringmap_insert(Globals, "agy", AgyMod);
    stringmap_insert(Globals, "gemini", GeminiMod);

    ml_externals_default_add("ai", AiMod);
    ml_externals_default_add("agy", AgyMod);
    ml_externals_default_add("gemini", GeminiMod);
}
