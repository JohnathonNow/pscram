#ifndef ML_DB_H
#define ML_DB_H

#include "minilang.h"
#include "stringmap.h"

/* Initialize the `db` SQLite module (`db::open`, `db::query`, `db::exec`) */
void ml_db_init(stringmap_t *Globals);

#endif /* ML_DB_H */
