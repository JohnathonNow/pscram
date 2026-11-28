#ifndef ML_IO_H
#define ML_IO_H

#include "minilang.h"
#include "stringmap.h"

#ifdef __cplusplus
extern "C" {
#endif

void ml_io_init(stringmap_t *Globals);

/* Shared JSON HTTP helper (uses dynamically loaded libcurl.so.4 with full HTTPS support).
 * ExtraHeaders is an optional NULL-terminated array of "Key: Value" strings.
 * If OutStatus is non-NULL, HTTP >= 400 responses are still decoded and returned (with *OutStatus set);
 * otherwise HTTP >= 400 returns an ml_error("HttpError", ...). */
ml_value_t *mlio_http_json_raw(
    const char *Method,
    const char *Url,
    const char *const *ExtraHeaders,
    const char *JsonBody,
    size_t BodyLen,
    long TimeoutSecs,
    long *OutStatus
);

/* Shared streaming HTTP helper (invokes OnChunk incrementally as bytes arrive from libcurl).
 * Return non-zero from OnChunk to abort streaming early. */
typedef int (*mlio_stream_chunk_cb)(const char *Data, size_t Len, void *Ctx);

ml_value_t *mlio_http_stream_raw(
    const char *Method,
    const char *Url,
    const char *const *ExtraHeaders,
    const char *JsonBody,
    size_t BodyLen,
    long TimeoutSecs,
    mlio_stream_chunk_cb OnChunk,
    void *Ctx,
    long *OutStatus
);

#ifdef __cplusplus
}
#endif

#endif
