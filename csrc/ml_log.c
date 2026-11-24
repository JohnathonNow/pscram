#include "ml_log.h"
#include "ml_macros.h"
#include "ml_cbor.h"
#include "ml_time.h"
#include "ml_types.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* ============================================================================
 * Persistent & In-Memory Append-Only Log of Arbitrary Minilang Values
 *
 * Binary framing on disk (per entry):
 *   [4 bytes]  Magic: "MLOG"
 *   [8 bytes]  Little-endian int64_t:  UTC epoch seconds (tv_sec)
 *   [4 bytes]  Little-endian uint32_t: nanoseconds (tv_nsec)
 *   [4 bytes]  Little-endian uint32_t: CBOR payload byte length
 *   [N bytes]  CBOR-encoded Minilang value (ml_cbor_encode)
 * ============================================================================ */

#define MLOG_MAGIC_0 'M'
#define MLOG_MAGIC_1 'L'
#define MLOG_MAGIC_2 'O'
#define MLOG_MAGIC_3 'G'
#define MLOG_HEADER_SIZE 20

typedef struct {
    int64_t Sec;
    uint32_t Nsec;
    ml_value_t *Value;
} ml_log_entry_t;

typedef struct {
    ml_type_t *Type;
    const char *Path;        /* NULL for in-memory log */
    FILE *File;              /* NULL for in-memory or closed log */
    int ReadOnly;
    int Closed;
    long FileOffset;         /* Byte offset of next unread record on disk */
    ml_log_entry_t *Entries; /* GC-allocated array so values stay traced! */
    size_t Count;
    size_t Capacity;
} ml_log_t;

typedef struct {
    ml_type_t *Type;
    ml_log_t *Log;
    size_t Index; /* 0-based index into Log->Entries */
} ml_log_iter_t;

static void write_le64(unsigned char *Out, uint64_t V) {
    for (int I = 0; I < 8; ++I) Out[I] = (unsigned char)((V >> (8 * I)) & 0xFF);
}

static uint64_t read_le64(const unsigned char *In) {
    uint64_t V = 0;
    for (int I = 0; I < 8; ++I) V |= ((uint64_t)In[I]) << (8 * I);
    return V;
}

static void write_le32(unsigned char *Out, uint32_t V) {
    for (int I = 0; I < 4; ++I) Out[I] = (unsigned char)((V >> (8 * I)) & 0xFF);
}

static uint32_t read_le32(const unsigned char *In) {
    uint32_t V = 0;
    for (int I = 0; I < 4; ++I) V |= ((uint32_t)In[I]) << (8 * I);
    return V;
}

static int mlog_mkdir_p_parent(const char *Path) {
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

static void mlog_finalize(ml_log_t *Log, void *Unused) {
    (void)Unused;
    if (Log->File) {
        fflush(Log->File);
        fclose(Log->File);
        Log->File = NULL;
    }
}

static void mlog_push_mem(ml_log_t *Log, int64_t Sec, uint32_t Nsec, ml_value_t *Val) {
    if (Log->Count >= Log->Capacity) {
        size_t NewCap = Log->Capacity ? Log->Capacity * 2 : 16;
        ml_log_entry_t *NewArr = anew(ml_log_entry_t, NewCap);
        if (Log->Count > 0 && Log->Entries) {
            memcpy(NewArr, Log->Entries, Log->Count * sizeof(ml_log_entry_t));
        }
        Log->Entries = NewArr;
        Log->Capacity = NewCap;
    }
    Log->Entries[Log->Count].Sec = Sec;
    Log->Entries[Log->Count].Nsec = Nsec;
    Log->Entries[Log->Count].Value = Val;
    Log->Count++;
}

/* Incrementally reads framed CBOR records starting from Log->FileOffset.
 * Returns number of newly loaded records, or -1 on fatal I/O error. */
static ssize_t mlog_read_from_disk(ml_log_t *Log, char *ErrBuf, size_t ErrCap) {
    if (!Log->File) return 0;
    if (fseek(Log->File, Log->FileOffset, SEEK_SET) != 0) {
        snprintf(ErrBuf, ErrCap, "Failed to seek log '%s': %s", Log->Path, strerror(errno));
        return -1;
    }

    ssize_t Loaded = 0;
    unsigned char Header[MLOG_HEADER_SIZE];
    for (;;) {
        long FrameStart = ftell(Log->File);
        size_t N = fread(Header, 1, MLOG_HEADER_SIZE, Log->File);
        if (N == 0) {
            break; /* Clean EOF */
        }
        if (N < MLOG_HEADER_SIZE) {
            /* Partial trailing header from an interrupted write; rewind cleanly */
            fseek(Log->File, FrameStart, SEEK_SET);
            break;
        }
        if (Header[0] != MLOG_MAGIC_0 || Header[1] != MLOG_MAGIC_1 ||
            Header[2] != MLOG_MAGIC_2 || Header[3] != MLOG_MAGIC_3) {
            snprintf(ErrBuf, ErrCap, "Corrupt log header in '%s' at byte %ld", Log->Path, FrameStart);
            return -1;
        }
        int64_t Sec = (int64_t)read_le64(Header + 4);
        uint32_t Nsec = read_le32(Header + 12);
        uint32_t CborLen = read_le32(Header + 16);
        if (CborLen == 0 || CborLen > 128U * 1024U * 1024U) {
            snprintf(ErrBuf, ErrCap, "Invalid log record length (%u) in '%s'", CborLen, Log->Path);
            return -1;
        }

        char *GcBuf = snew(CborLen);
        size_t Got = fread(GcBuf, 1, CborLen, Log->File);
        if (Got < CborLen) {
            /* Partial trailing payload; rewind cleanly */
            fseek(Log->File, FrameStart, SEEK_SET);
            break;
        }

        ml_cbor_t Cbor = {{.Data = GcBuf}, CborLen};
        ml_value_t *Decoded = ml_from_cbor(Cbor, NULL, NULL);
        if (ml_is_error(Decoded)) {
            snprintf(ErrBuf, ErrCap, "Failed to decode CBOR entry in '%s': %s",
                Log->Path, ml_error_message(Decoded));
            return -1;
        }

        mlog_push_mem(Log, Sec, Nsec, Decoded);
        Log->FileOffset = ftell(Log->File);
        Loaded++;
    }
    return Loaded;
}

static ml_value_t *mlog_append_one(ml_log_t *Log, ml_value_t *RawVal) {
    if (Log->Closed) {
        return ml_error("LogError", "Cannot append to closed log");
    }
    if (Log->ReadOnly) {
        return ml_error("LogError", "Cannot append to read-only log '%s'", Log->Path ? Log->Path : "");
    }

    ml_value_t *Val = ml_deref(RawVal);
    struct timespec Ts;
    clock_gettime(CLOCK_REALTIME, &Ts);
    int64_t Sec = (int64_t)Ts.tv_sec;
    uint32_t Nsec = (uint32_t)Ts.tv_nsec;

    if (Log->File) {
        ml_cbor_t Cbor = ml_cbor_encode(Val);
        if (!Cbor.Length || !Cbor.Data) {
            return Cbor.Error ? Cbor.Error : ml_error("CBORError", "Value cannot be CBOR-encoded into file-backed log");
        }
        if (Cbor.Length > 128U * 1024U * 1024U) {
            return ml_error("LogError", "Log entry exceeds 128 MB limit");
        }

        unsigned char Header[MLOG_HEADER_SIZE];
        Header[0] = MLOG_MAGIC_0;
        Header[1] = MLOG_MAGIC_1;
        Header[2] = MLOG_MAGIC_2;
        Header[3] = MLOG_MAGIC_3;
        write_le64(Header + 4, (uint64_t)Sec);
        write_le32(Header + 12, Nsec);
        write_le32(Header + 16, (uint32_t)Cbor.Length);

        if (fseek(Log->File, 0, SEEK_END) != 0) {
            return ml_error("LogError", "Failed to seek log '%s': %s", Log->Path, strerror(errno));
        }
        if (fwrite(Header, 1, MLOG_HEADER_SIZE, Log->File) != MLOG_HEADER_SIZE ||
            fwrite(Cbor.Data, 1, Cbor.Length, Log->File) != Cbor.Length ||
            fflush(Log->File) != 0) {
            return ml_error("LogError", "Failed to write entry to log '%s': %s", Log->Path, strerror(errno));
        }
        Log->FileOffset = ftell(Log->File);
    }

    mlog_push_mem(Log, Sec, Nsec, Val);
    return NULL;
}

static ml_value_t *mlog_entry_map(const ml_log_t *Log, size_t ZeroIdx) {
    const ml_log_entry_t *E = &Log->Entries[ZeroIdx];
    ml_value_t *Map = ml_map();
    ml_map_insert(Map, ml_cstring("index"), ml_integer((int64_t)(ZeroIdx + 1)));
    ml_map_insert(Map, ml_cstring("time"), ml_time((time_t)E->Sec, (unsigned long)E->Nsec));
    ml_map_insert(Map, ml_cstring("value"), E->Value);
    return Map;
}

static int mlog_resolve_index(size_t Count, int64_t RawIndex, size_t *OutIdx) {
    if (RawIndex > 0) {
        if ((uint64_t)RawIndex > Count) return 0;
        *OutIdx = (size_t)(RawIndex - 1);
        return 1;
    } else if (RawIndex < 0) {
        int64_t Pos = (int64_t)Count + RawIndex;
        if (Pos < 0 || (size_t)Pos >= Count) return 0;
        *OutIdx = (size_t)Pos;
        return 1;
    }
    return 0;
}

/* ============================================================================
 * Iterator (MLSequenceT) Implementation
 * ============================================================================ */

static void ml_log_iter_value(ml_state_t *Caller, ml_log_iter_t *Iter) {
    ML_RETURN(Iter->Log->Entries[Iter->Index].Value);
}

static void ml_log_iter_key(ml_state_t *Caller, ml_log_iter_t *Iter) {
    const ml_log_entry_t *E = &Iter->Log->Entries[Iter->Index];
    ML_RETURN(ml_time((time_t)E->Sec, (unsigned long)E->Nsec));
}

static void ml_log_iter_next(ml_state_t *Caller, ml_log_iter_t *Iter) {
    if (Iter->Index + 1 < Iter->Log->Count) {
        Iter->Index++;
        ML_RETURN(Iter);
    }
    ML_RETURN(MLNil);
}

ML_TYPE(MLLogIterT, (), "log::iterator",
    .iter_value = (void *)ml_log_iter_value,
    .iter_key = (void *)ml_log_iter_key,
    .iter_next = (void *)ml_log_iter_next
);

static void ml_log_iterate(ml_state_t *Caller, ml_log_t *Log) {
    if (Log->Count == 0) {
        ML_RETURN(MLNil);
    }
    ml_log_iter_t *Iter = new(ml_log_iter_t);
    Iter->Type = MLLogIterT;
    Iter->Log = Log;
    Iter->Index = 0;
    ML_RETURN(Iter);
}

/* Calling a log directly: `L(val)` or `L(v1, v2, ...)` appends values and returns L */
static void ml_log_call(ml_state_t *Caller, ml_log_t *Log, int Count, ml_value_t **Args) {
    for (int I = 0; I < Count; ++I) {
        ml_value_t *Err = mlog_append_one(Log, Args[I]);
        if (Err) ML_RETURN(Err);
    }
    ML_RETURN((ml_value_t *)Log);
}

/* ============================================================================
 * Constructor: log(), log(Path), log(Path, Mode)
 * ============================================================================ */

ML_FUNCTION(MLLogNew) {
    ml_log_t *Log = new(ml_log_t);
    Log->Type = MLLogT;
    Log->Path = NULL;
    Log->File = NULL;
    Log->ReadOnly = 0;
    Log->Closed = 0;
    Log->FileOffset = 0;
    Log->Entries = NULL;
    Log->Count = 0;
    Log->Capacity = 0;

    if (Count == 0 || ml_deref(Args[0]) == MLNil) {
        return (ml_value_t *)Log;
    }

    ML_CHECK_ARG_TYPE(0, MLStringT);
    const char *PathRaw = ml_string_value(Args[0]);
    size_t PathLen = ml_string_length(Args[0]);
    char *GcPath = snew(PathLen + 1);
    memcpy(GcPath, PathRaw, PathLen + 1);
    Log->Path = GcPath;

    const char *Mode = "a";
    if (Count >= 2 && ml_deref(Args[1]) != MLNil) {
        ML_CHECK_ARG_TYPE(1, MLStringT);
        Mode = ml_string_value(Args[1]);
    }

    int Truncate = 0;
    if (strcmp(Mode, "r") == 0) {
        Log->ReadOnly = 1;
    } else if (strcmp(Mode, "w") == 0) {
        Truncate = 1;
    } else if (strcmp(Mode, "a") != 0 && strcmp(Mode, "rw") != 0 && strcmp(Mode, "a+") != 0) {
        return ml_error("ValueError", "Invalid log mode '%s' (expected \"a\", \"r\", or \"w\")", Mode);
    }

    if (!Log->ReadOnly) {
        if (mlog_mkdir_p_parent(Log->Path) != 0) {
            return ml_error("LogError", "Failed to create parent directories for '%s': %s",
                Log->Path, strerror(errno));
        }
    }

    FILE *Fp = NULL;
    if (Log->ReadOnly) {
        Fp = fopen(Log->Path, "rb");
    } else if (Truncate) {
        Fp = fopen(Log->Path, "w+b");
    } else {
        /* Open existing for read/write without truncating, or create if missing */
        Fp = fopen(Log->Path, "r+b");
        if (!Fp && errno == ENOENT) {
            Fp = fopen(Log->Path, "w+b");
        }
    }

    if (!Fp) {
        return ml_error("LogError", "Failed to open log '%s': %s", Log->Path, strerror(errno));
    }

    Log->File = Fp;
    GC_register_finalizer(Log, (void *)mlog_finalize, 0, 0, 0);

    if (!Truncate) {
        char ErrBuf[512];
        if (mlog_read_from_disk(Log, ErrBuf, sizeof(ErrBuf)) < 0) {
            fclose(Log->File);
            Log->File = NULL;
            return ml_error("LogError", "%s", ErrBuf);
        }
    }

    return (ml_value_t *)Log;
}

ML_TYPE(MLLogT, (MLSequenceT), "log",
    .Constructor = (ml_value_t *)MLLogNew,
    .call = (void *)ml_log_call,
    .iterate = (void *)ml_log_iterate
);

/* ============================================================================
 * Methods on MLLogT
 * ============================================================================ */

static ml_value_t *mlog_method_put(void *Data, int Count, ml_value_t **Args) {
    (void)Data;
    ml_log_t *Log = (ml_log_t *)Args[0];
    for (int I = 1; I < Count; ++I) {
        ml_value_t *Err = mlog_append_one(Log, Args[I]);
        if (Err) return Err;
    }
    return (ml_value_t *)Log;
}

static ml_value_t *mlog_method_count(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    return ml_integer((int64_t)Log->Count);
}

static ml_value_t *mlog_method_index(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    int64_t Idx = ml_integer_value(Args[1]);
    size_t Pos = 0;
    if (!mlog_resolve_index(Log->Count, Idx, &Pos)) return MLNil;
    return Log->Entries[Pos].Value;
}

static ml_value_t *mlog_method_slice(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    int64_t Start = ml_integer_value(Args[1]);
    int64_t End = ml_integer_value(Args[2]);
    int64_t N = (int64_t)Log->Count;

    if (Start <= 0) Start += N + 1;
    if (End <= 0) End += N + 1;
    if (Start < 1) Start = 1;
    if (End > N + 1) End = N + 1;

    ml_value_t *List = ml_list();
    for (int64_t I = Start; I < End; ++I) {
        ml_list_put(List, Log->Entries[(size_t)(I - 1)].Value);
    }
    return List;
}

static ml_value_t *mlog_method_first(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (Log->Count == 0) return MLNil;
    return Log->Entries[0].Value;
}

static ml_value_t *mlog_method_last(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (Log->Count == 0) return MLNil;
    return Log->Entries[Log->Count - 1].Value;
}

static ml_value_t *mlog_method_entry(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    int64_t Idx = ml_integer_value(Args[1]);
    size_t Pos = 0;
    if (!mlog_resolve_index(Log->Count, Idx, &Pos)) return MLNil;
    return mlog_entry_map(Log, Pos);
}

static ml_value_t *mlog_method_time(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    int64_t Idx = ml_integer_value(Args[1]);
    size_t Pos = 0;
    if (!mlog_resolve_index(Log->Count, Idx, &Pos)) return MLNil;
    return ml_time((time_t)Log->Entries[Pos].Sec, (unsigned long)Log->Entries[Pos].Nsec);
}

static ml_value_t *mlog_method_entries(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    ml_value_t *List = ml_list();
    for (size_t I = 0; I < Log->Count; ++I) {
        ml_list_put(List, mlog_entry_map(Log, I));
    }
    return List;
}

static ml_value_t *mlog_method_values(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    ml_value_t *List = ml_list();
    for (size_t I = 0; I < Log->Count; ++I) {
        ml_list_put(List, Log->Entries[I].Value);
    }
    return List;
}

static ml_value_t *mlog_method_tail(void *Data, int Count, ml_value_t **Args) {
    (void)Data;
    ml_log_t *Log = (ml_log_t *)Args[0];
    int64_t Limit = (Count >= 2 && ml_is(Args[1], MLIntegerT)) ? ml_integer_value(Args[1]) : 10;
    if (Limit < 0) Limit = 0;
    size_t Start = ((size_t)Limit >= Log->Count) ? 0 : (Log->Count - (size_t)Limit);
    ml_value_t *List = ml_list();
    for (size_t I = Start; I < Log->Count; ++I) {
        ml_list_put(List, Log->Entries[I].Value);
    }
    return List;
}

static ml_value_t *mlog_method_head(void *Data, int Count, ml_value_t **Args) {
    (void)Data;
    ml_log_t *Log = (ml_log_t *)Args[0];
    int64_t Limit = (Count >= 2 && ml_is(Args[1], MLIntegerT)) ? ml_integer_value(Args[1]) : 10;
    if (Limit < 0) Limit = 0;
    size_t End = ((size_t)Limit > Log->Count) ? Log->Count : (size_t)Limit;
    ml_value_t *List = ml_list();
    for (size_t I = 0; I < End; ++I) {
        ml_list_put(List, Log->Entries[I].Value);
    }
    return List;
}

static ml_value_t *mlog_method_since(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    ml_value_t *TArg = ml_deref(Args[1]);
    int64_t CutSec = 0;
    uint32_t CutNsec = 0;

    if (ml_is(TArg, MLTimeT)) {
        struct timespec Ts;
        ml_time_value(TArg, &Ts);
        CutSec = (int64_t)Ts.tv_sec;
        CutNsec = (uint32_t)Ts.tv_nsec;
    } else if (ml_is(TArg, MLIntegerT)) {
        CutSec = ml_integer_value(TArg);
    } else if (ml_is(TArg, MLRealT)) {
        double D = ml_real_value(TArg);
        CutSec = (int64_t)D;
        double Frac = D - (double)CutSec;
        if (Frac < 0) Frac = 0;
        CutNsec = (uint32_t)(Frac * 1e9);
    } else {
        return ml_error("TypeError", "log:since expects a time, integer, or real timestamp");
    }

    ml_value_t *List = ml_list();
    for (size_t I = 0; I < Log->Count; ++I) {
        const ml_log_entry_t *E = &Log->Entries[I];
        if (E->Sec > CutSec || (E->Sec == CutSec && E->Nsec >= CutNsec)) {
            ml_list_put(List, mlog_entry_map(Log, I));
        }
    }
    return List;
}

static ml_value_t *mlog_method_path(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (!Log->Path) return MLNil;
    return ml_string(Log->Path, -1);
}

static ml_value_t *mlog_method_flush(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (Log->File) {
        fflush(Log->File);
        fsync(fileno(Log->File));
    }
    return (ml_value_t *)Log;
}

static ml_value_t *mlog_method_reload(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (!Log->File) return ml_integer(0);
    clearerr(Log->File);
    char ErrBuf[512];
    ssize_t Added = mlog_read_from_disk(Log, ErrBuf, sizeof(ErrBuf));
    if (Added < 0) return ml_error("LogError", "%s", ErrBuf);
    return ml_integer((int64_t)Added);
}

static ml_value_t *mlog_method_clear(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (Log->Closed) return ml_error("LogError", "Cannot clear closed log");
    if (Log->ReadOnly) return ml_error("LogError", "Cannot clear read-only log");
    if (Log->File) {
        fflush(Log->File);
        if (ftruncate(fileno(Log->File), 0) != 0) {
            return ml_error("LogError", "Failed to truncate log '%s': %s", Log->Path, strerror(errno));
        }
        rewind(Log->File);
        Log->FileOffset = 0;
    }
    Log->Count = 0;
    return (ml_value_t *)Log;
}

static ml_value_t *mlog_method_close(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_log_t *Log = (ml_log_t *)Args[0];
    if (Log->File) {
        fflush(Log->File);
        fclose(Log->File);
        Log->File = NULL;
    }
    Log->Closed = 1;
    return MLNil;
}

static ml_value_t *mlog_method_sb_append(void *Data, int Count, ml_value_t **Args) {
    (void)Data; (void)Count;
    ml_stringbuffer_t *Sb = (ml_stringbuffer_t *)Args[0];
    ml_log_t *Log = (ml_log_t *)Args[1];
    if (Log->Path) {
        ml_stringbuffer_printf(Sb, "<log \"%s\" (%zu %s)>",
            Log->Path, Log->Count, Log->Count == 1 ? "entry" : "entries");
    } else {
        ml_stringbuffer_printf(Sb, "<log (%zu %s)>",
            Log->Count, Log->Count == 1 ? "entry" : "entries");
    }
    return MLSome;
}

/* ============================================================================
 * Module / Type Registration
 * ============================================================================ */

void ml_log_init(stringmap_t *Globals) {
    ml_type_init(MLLogIterT, NULL);
    ml_type_init(MLLogT, MLSequenceT, NULL);

    ml_typed_fn_set(MLLogT, (void *)ml_iterate, (void *)ml_log_iterate);
    ml_typed_fn_set(MLLogIterT, (void *)ml_iter_value, (void *)ml_log_iter_value);
    ml_typed_fn_set(MLLogIterT, (void *)ml_iter_key, (void *)ml_log_iter_key);
    ml_typed_fn_set(MLLogIterT, (void *)ml_iter_next, (void *)ml_log_iter_next);

    ml_value_t *PutFn = ml_cfunction(NULL, (ml_callback_t)mlog_method_put);
    ml_method_definev(ml_method("put"), PutFn, NULL, MLLogT, MLAnyT, NULL);
    ml_method_definev(ml_method("push"), PutFn, NULL, MLLogT, MLAnyT, NULL);
    ml_method_definev(ml_method("write"), PutFn, NULL, MLLogT, MLAnyT, NULL);
    ml_method_definev(ml_method("add"), PutFn, NULL, MLLogT, MLAnyT, NULL);
    ml_method_definev(ml_method("append"), PutFn, NULL, MLLogT, MLAnyT, NULL);

    ml_value_t *CountFn = ml_cfunction(NULL, (ml_callback_t)mlog_method_count);
    ml_method_definev(ml_method("count"), CountFn, NULL, MLLogT, NULL);
    ml_method_definev(ml_method("length"), CountFn, NULL, MLLogT, NULL);
    ml_method_definev(ml_method("size"), CountFn, NULL, MLLogT, NULL);

    ml_method_definev(ml_method("[]"), ml_cfunction(NULL, (ml_callback_t)mlog_method_index), NULL, MLLogT, MLIntegerT, NULL);
    ml_method_definev(ml_method("[]"), ml_cfunction(NULL, (ml_callback_t)mlog_method_slice), NULL, MLLogT, MLIntegerT, MLIntegerT, NULL);

    ml_method_definev(ml_method("first"), ml_cfunction(NULL, (ml_callback_t)mlog_method_first), NULL, MLLogT, NULL);
    ml_method_definev(ml_method("last"), ml_cfunction(NULL, (ml_callback_t)mlog_method_last), NULL, MLLogT, NULL);
    ml_method_definev(ml_method("entry"), ml_cfunction(NULL, (ml_callback_t)mlog_method_entry), NULL, MLLogT, MLIntegerT, NULL);
    ml_method_definev(ml_method("time"), ml_cfunction(NULL, (ml_callback_t)mlog_method_time), NULL, MLLogT, MLIntegerT, NULL);
    ml_method_definev(ml_method("entries"), ml_cfunction(NULL, (ml_callback_t)mlog_method_entries), NULL, MLLogT, NULL);
    ml_method_definev(ml_method("values"), ml_cfunction(NULL, (ml_callback_t)mlog_method_values), NULL, MLLogT, NULL);

    ml_value_t *TailFn = ml_cfunction(NULL, (ml_callback_t)mlog_method_tail);
    ml_method_definev(ml_method("tail"), TailFn, NULL, MLLogT, NULL);
    ml_method_definev(ml_method("tail"), TailFn, NULL, MLLogT, MLIntegerT, NULL);

    ml_value_t *HeadFn = ml_cfunction(NULL, (ml_callback_t)mlog_method_head);
    ml_method_definev(ml_method("head"), HeadFn, NULL, MLLogT, NULL);
    ml_method_definev(ml_method("head"), HeadFn, NULL, MLLogT, MLIntegerT, NULL);

    ml_method_definev(ml_method("since"), ml_cfunction(NULL, (ml_callback_t)mlog_method_since), NULL, MLLogT, MLAnyT, NULL);
    ml_method_definev(ml_method("path"), ml_cfunction(NULL, (ml_callback_t)mlog_method_path), NULL, MLLogT, NULL);

    ml_value_t *FlushFn = ml_cfunction(NULL, (ml_callback_t)mlog_method_flush);
    ml_method_definev(ml_method("flush"), FlushFn, NULL, MLLogT, NULL);
    ml_method_definev(ml_method("sync"), FlushFn, NULL, MLLogT, NULL);

    ml_method_definev(ml_method("reload"), ml_cfunction(NULL, (ml_callback_t)mlog_method_reload), NULL, MLLogT, NULL);
    ml_method_definev(ml_method("clear"), ml_cfunction(NULL, (ml_callback_t)mlog_method_clear), NULL, MLLogT, NULL);
    ml_method_definev(ml_method("close"), ml_cfunction(NULL, (ml_callback_t)mlog_method_close), NULL, MLLogT, NULL);

    ml_method_definev(
        ml_method("append"),
        ml_cfunction(NULL, (ml_callback_t)mlog_method_sb_append),
        NULL,
        MLStringBufferT,
        MLLogT,
        NULL
    );

    stringmap_insert(Globals, "log", MLLogT);
    ml_externals_default_add("log", MLLogT);
}
