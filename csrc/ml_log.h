#ifndef ML_LOG_H
#define ML_LOG_H

#include "minilang.h"
#include "stringmap.h"

#ifdef __cplusplus
extern "C" {
#endif

extern ml_type_t MLLogT[];

void ml_log_init(stringmap_t *Globals);

#ifdef __cplusplus
}
#endif

#endif
