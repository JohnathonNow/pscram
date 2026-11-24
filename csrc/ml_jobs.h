#ifndef ML_JOBS_H
#define ML_JOBS_H

#include "minilang.h"
#include "stringmap.h"

/* Initialize the `jobs` module (`jobs::start`, `jobs::list`, `jobs::wait`, `jobs::stop`, ...) */
void ml_jobs_init(stringmap_t *Globals);

#endif /* ML_JOBS_H */
