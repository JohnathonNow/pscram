#ifndef ML_UI_H
#define ML_UI_H

#include "minilang.h"
#include "stringmap.h"

typedef void (*ml_ui_emit_fn)(const char *mime, const char *data, size_t len);

extern ml_type_t MLUIWidgetT[];
extern ml_type_t MLUIAppT[];

void ml_ui_init(stringmap_t *Globals, ml_ui_emit_fn emit_fn);

#endif
