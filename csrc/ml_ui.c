#include "ml_ui.h"
#include "ml_macros.h"
#include "ml_minijs.h"
#include "ml_json.h"
#include "ml_compiler.h"
#include "ml_types.h"
#include <stdio.h>
#include <string.h>

typedef struct {
    ml_type_t *Type;
    const char *Kind;
    ml_value_t *Props;    /* ml_map_t */
    ml_value_t *Children; /* ml_list_t */
    ml_value_t *Handlers; /* ml_map_t: event_name -> closure */
} ml_ui_widget_t;

typedef struct {
    ml_type_t *Type;
    ml_value_t *MinijsValue; /* minijs-encoded ml_value_t */
    const char *JsonString;
    size_t JsonLength;
} ml_ui_app_t;

static ml_ui_emit_fn g_ui_emit = NULL;

ML_TYPE(MLUIWidgetT, (), "ui::widget");
ML_TYPE(MLUIAppT, (), "ui::compiled");

static ml_ui_widget_t *ml_ui_widget_new(const char *Kind) {
    ml_ui_widget_t *W = new(ml_ui_widget_t);
    W->Type = MLUIWidgetT;
    W->Kind = Kind;
    W->Props = ml_map();
    W->Children = ml_list();
    W->Handlers = ml_map();
    return W;
}

static void ml_ui_prop_set(ml_ui_widget_t *W, const char *Key, ml_value_t *Val) {
    ml_map_insert(W->Props, ml_string(Key, -1), ml_deref(Val));
}

static void ml_ui_handler_set(ml_ui_widget_t *W, const char *Event, ml_value_t *Fn) {
    ml_map_insert(W->Handlers, ml_string(Event, -1), ml_deref(Fn));
}

/* Parse trailing named args (MLNamesT) into Props or Handlers (if prefixed with on_) */
static int ml_ui_consume_named_args(ml_ui_widget_t *W, int Count, ml_value_t **Args) {
    for (int I = 0; I < Count; ++I) {
        ml_value_t *Arg = ml_deref(Args[I]);
        if (ml_is(Arg, MLNamesT)) {
            int Pos = I + 1;
            ML_NAMES_FOREACH(Arg, Node) {
                if (Pos >= Count) break;
                const char *Key = ml_string_value(Node->Value);
                ml_value_t *Val = ml_deref(Args[Pos++]);
                if (strncmp(Key, "on_", 3) == 0) {
                    ml_ui_handler_set(W, Key + 3, Val);
                } else {
                    ml_ui_prop_set(W, Key, Val);
                }
            }
            return I; /* number of positional args before MLNamesT */
        }
    }
    return Count;
}

/* Append positional children (flattening lists if passed) and optional callback */
static void ml_ui_add_children(ml_ui_widget_t *W, int Start, int PosCount, ml_value_t **Args, const char *FnEvent) {
    for (int I = Start; I < PosCount; ++I) {
        ml_value_t *Arg = ml_deref(Args[I]);
        if (!Arg || Arg == MLNil) continue;
        if (ml_is(Arg, MLUIWidgetT)) {
            ml_list_put(W->Children, Arg);
        } else if (ml_is(Arg, MLListT)) {
            ML_LIST_FOREACH(Arg, Iter) {
                ml_value_t *Item = ml_deref(Iter->Value);
                if (ml_is(Item, MLUIWidgetT)) {
                    ml_list_put(W->Children, Item);
                } else if (ml_is(Item, MLStringT)) {
                    ml_ui_widget_t *Txt = ml_ui_widget_new("text");
                    ml_ui_prop_set(Txt, "text", Item);
                    ml_list_put(W->Children, (ml_value_t *)Txt);
                }
            }
        } else if (FnEvent && ml_is(Arg, MLFunctionT)) {
            ml_ui_handler_set(W, FnEvent, Arg);
        } else if (ml_is(Arg, MLMapT)) {
            ML_MAP_FOREACH(Arg, Iter) {
                ml_value_t *K = ml_deref(Iter->Key);
                ml_value_t *V = ml_deref(Iter->Value);
                if (ml_is(K, MLStringT)) {
                    const char *Ks = ml_string_value(K);
                    if (strncmp(Ks, "on_", 3) == 0) {
                        ml_ui_handler_set(W, Ks + 3, V);
                    } else {
                        ml_ui_prop_set(W, Ks, V);
                    }
                }
            }
        } else if (ml_is(Arg, MLStringT)) {
            ml_ui_widget_t *Txt = ml_ui_widget_new("text");
            ml_ui_prop_set(Txt, "text", Arg);
            ml_list_put(W->Children, (ml_value_t *)Txt);
        }
    }
}

/* --- Custom MiniJS encoder for MLUIWidgetT & MLUIAppT --- */

static ml_value_t *ml_ui_widget_minijs_encode(ml_minijs_encoder_t *Encoder, ml_ui_widget_t *W) {
    ml_value_t *Json = ml_list();
    ml_list_put(Json, ml_cstring("w"));
    /* Cache BEFORE encoding children/handlers so cyclic/shared widget references preserve identity! */
    inthash_insert(Encoder->Cached, (uintptr_t)W, Json);
    ml_list_put(Json, ml_string(W->Kind, -1));
    ml_list_put(Json, ml_minijs_encode(Encoder, W->Props));
    ml_list_put(Json, ml_minijs_encode(Encoder, W->Children));
    ml_list_put(Json, ml_minijs_encode(Encoder, W->Handlers));
    return Json;
}

static ml_value_t *ml_ui_app_minijs_encode(ml_minijs_encoder_t *Encoder, ml_ui_app_t *App) {
    ml_value_t *Json = ml_list();
    ml_list_put(Json, ml_cstring("u"));
    inthash_insert(Encoder->Cached, (uintptr_t)App, Json);
    ml_list_put(Json, App->MinijsValue);
    return Json;
}

/* --- Container Widgets --- */

static ml_value_t *ui_vbox_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("vbox");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    ml_ui_add_children(W, 0, Pos, Args, NULL);
    return (ml_value_t *)W;
}

static ml_value_t *ui_hbox_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("hbox");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    ml_ui_add_children(W, 0, Pos, Args, NULL);
    return (ml_value_t *)W;
}

static ml_value_t *ui_grid_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("grid");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    int Start = 0;
    if (Pos > 0 && ml_is(ml_deref(Args[0]), MLIntegerT)) {
        ml_ui_prop_set(W, "columns", Args[0]);
        Start = 1;
    }
    ml_ui_add_children(W, Start, Pos, Args, NULL);
    return (ml_value_t *)W;
}

static ml_value_t *ui_card_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("card");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    int Start = 0;
    if (Pos > 0 && ml_is(ml_deref(Args[0]), MLStringT)) {
        ml_ui_prop_set(W, "title", Args[0]);
        Start = 1;
    }
    ml_ui_add_children(W, Start, Pos, Args, NULL);
    return (ml_value_t *)W;
}

static ml_value_t *ui_panel_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("panel");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    ml_ui_add_children(W, 0, Pos, Args, NULL);
    return (ml_value_t *)W;
}

static ml_value_t *ui_form_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("form");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    ml_ui_add_children(W, 0, Pos, Args, "submit");
    return (ml_value_t *)W;
}

static ml_value_t *ui_tabs_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("tabs");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    ml_value_t *Titles = ml_list();
    if (Pos > 0 && ml_is(ml_deref(Args[0]), MLMapT)) {
        ML_MAP_FOREACH(ml_deref(Args[0]), Iter) {
            ml_list_put(Titles, ml_deref(Iter->Key));
            ml_list_put(W->Children, ml_deref(Iter->Value));
        }
    }
    ml_ui_prop_set(W, "titles", Titles);
    return (ml_value_t *)W;
}

/* --- Display & Raw HTML Widgets --- */

static ml_value_t *ui_text_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("text");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0) ml_ui_prop_set(W, "text", Args[0]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_label_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("label");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0) ml_ui_prop_set(W, "text", Args[0]);
    if (Pos > 1 && ml_is(ml_deref(Args[1]), MLUIWidgetT)) {
        ml_list_put(W->Children, ml_deref(Args[1]));
    }
    return (ml_value_t *)W;
}

static ml_value_t *ui_heading_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("heading");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0) ml_ui_prop_set(W, "text", Args[0]);
    if (Pos > 1) ml_ui_prop_set(W, "level", Args[1]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_html_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("html");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0) ml_ui_prop_set(W, "html", Args[0]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_divider_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("divider");
    ml_ui_consume_named_args(W, Count, Args);
    return (ml_value_t *)W;
}

static ml_value_t *ui_badge_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("badge");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0) ml_ui_prop_set(W, "text", Args[0]);
    if (Pos > 1) ml_ui_prop_set(W, "variant", Args[1]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_code_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("code");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0) ml_ui_prop_set(W, "text", Args[0]);
    return (ml_value_t *)W;
}

/* --- Form Element Widgets --- */

static ml_value_t *ui_input_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("input");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "placeholder", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "value", Args[1]);
    if (Pos > 2 && ml_is(ml_deref(Args[2]), MLFunctionT)) ml_ui_handler_set(W, "input", Args[2]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_password_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("password");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "placeholder", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "value", Args[1]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_textarea_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("textarea");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "placeholder", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "value", Args[1]);
    if (Pos > 2 && ml_is(ml_deref(Args[2]), MLIntegerT)) ml_ui_prop_set(W, "rows", Args[2]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_number_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("number");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "value", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "min", Args[1]);
    if (Pos > 2 && ml_deref(Args[2]) != MLNil) ml_ui_prop_set(W, "max", Args[2]);
    if (Pos > 3 && ml_deref(Args[3]) != MLNil) ml_ui_prop_set(W, "step", Args[3]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_slider_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("slider");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "value", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "min", Args[1]);
    if (Pos > 2 && ml_deref(Args[2]) != MLNil) ml_ui_prop_set(W, "max", Args[2]);
    if (Pos > 3 && ml_deref(Args[3]) != MLNil) ml_ui_prop_set(W, "step", Args[3]);
    if (Pos > 4 && ml_is(ml_deref(Args[4]), MLFunctionT)) ml_ui_handler_set(W, "input", Args[4]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_checkbox_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("checkbox");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "label", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "checked", Args[1]);
    if (Pos > 2 && ml_is(ml_deref(Args[2]), MLFunctionT)) ml_ui_handler_set(W, "change", Args[2]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_select_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("select");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "options", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "value", Args[1]);
    if (Pos > 2 && ml_is(ml_deref(Args[2]), MLFunctionT)) ml_ui_handler_set(W, "change", Args[2]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_radio_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("radio");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "options", Args[0]);
    if (Pos > 1 && ml_deref(Args[1]) != MLNil) ml_ui_prop_set(W, "value", Args[1]);
    if (Pos > 2 && ml_is(ml_deref(Args[2]), MLFunctionT)) ml_ui_handler_set(W, "change", Args[2]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_date_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("date");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "value", Args[0]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_color_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("color");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "value", Args[0]);
    return (ml_value_t *)W;
}

static ml_value_t *ui_button_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = ml_ui_widget_new("button");
    int Pos = ml_ui_consume_named_args(W, Count, Args);
    if (Pos > 0 && ml_deref(Args[0]) != MLNil) ml_ui_prop_set(W, "label", Args[0]);
    if (Pos > 1 && ml_is(ml_deref(Args[1]), MLFunctionT)) ml_ui_handler_set(W, "click", Args[1]);
    return (ml_value_t *)W;
}

/* --- ui::compile & ui::show --- */

static ml_value_t *ml_ui_compile_value(ml_value_t *Target) {
    Target = ml_deref(Target);
    const char *Mode = "widget";
    if (ml_is(Target, MLUIAppT)) {
        return Target;
    } else if (ml_is(Target, MLFunctionT)) {
        Mode = "function";
    } else if (ml_is(Target, MLUIWidgetT)) {
        Mode = "widget";
    } else {
        return ml_error("TypeError", "ui::compile expects a ui::widget or function, not %s", ml_typeof(Target)->Name);
    }

    ml_minijs_encoder_t Encoder[1] = {{MLExternals, NULL, {INTHASH_INIT}, 0}};
    ml_value_t *Encoded = ml_minijs_encode(Encoder, Target);
    if (ml_is_error(Encoded)) return Encoded;

    ml_value_t *Envelope = ml_map();
    ml_map_insert(Envelope, ml_cstring("format"), ml_cstring("minilang-ui"));
    ml_map_insert(Envelope, ml_cstring("version"), ml_integer(1));
    ml_map_insert(Envelope, ml_cstring("mode"), ml_string(Mode, -1));
    ml_map_insert(Envelope, ml_cstring("minijs"), Encoded);

    ml_stringbuffer_t Buf[1] = {ML_STRINGBUFFER_INIT};
    ml_value_t *Err = ml_json_encode(Buf, Envelope);
    if (Err) return Err;
    size_t Len = Buf->Length;
    const char *Json = ml_stringbuffer_get_string(Buf);

    ml_ui_app_t *App = new(ml_ui_app_t);
    App->Type = MLUIAppT;
    App->MinijsValue = Encoded;
    App->JsonString = Json ? Json : "{}";
    App->JsonLength = Len;
    return (ml_value_t *)App;
}

static ml_value_t *ui_compile_fn(void *Data, int Count, ml_value_t **Args) {
    ML_CHECK_ARG_COUNT(1);
    return ml_ui_compile_value(Args[0]);
}

static ml_value_t *ui_show_fn(void *Data, int Count, ml_value_t **Args) {
    ML_CHECK_ARG_COUNT(1);
    ml_value_t *Compiled = ml_ui_compile_value(Args[0]);
    if (ml_is_error(Compiled)) return Compiled;
    ml_ui_app_t *App = (ml_ui_app_t *)Compiled;
    if (g_ui_emit) {
        g_ui_emit("application/vnd.minilang.ui+json", App->JsonString, App->JsonLength);
    }
    return MLNil;
}

/* --- Widget Methods (usable on server while constructing widget trees) --- */

static ml_value_t *widget_on_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    ml_ui_handler_set(W, ml_string_value(ml_deref(Args[1])), Args[2]);
    return (ml_value_t *)W;
}

static ml_value_t *widget_on_event_fixed(void *EventName, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    ml_ui_handler_set(W, (const char *)EventName, Args[1]);
    return (ml_value_t *)W;
}

static ml_value_t *widget_append_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    ml_ui_add_children(W, 1, Count, Args, NULL);
    return (ml_value_t *)W;
}

static ml_value_t *widget_clear_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    W->Children = ml_list();
    return (ml_value_t *)W;
}

static ml_value_t *widget_get_prop_fn(void *PropName, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    ml_value_t *Val = ml_map_search(W->Props, ml_string((const char *)PropName, -1));
    return Val ? Val : MLNil;
}

static ml_value_t *widget_set_prop_fn(void *PropName, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    ml_ui_prop_set(W, (const char *)PropName, Args[1]);
    return (ml_value_t *)W;
}

static ml_value_t *widget_set_style_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_widget_t *W = (ml_ui_widget_t *)ml_deref(Args[0]);
    ml_value_t *Styles = ml_map_search(W->Props, ml_cstring("styles"));
    if (!Styles || !ml_is(Styles, MLMapT)) {
        Styles = ml_map();
        ml_ui_prop_set(W, "styles", Styles);
    }
    if (Count == 2 && ml_is(ml_deref(Args[1]), MLMapT)) {
        ML_MAP_FOREACH(ml_deref(Args[1]), Iter) {
            ml_map_insert(Styles, ml_deref(Iter->Key), ml_deref(Iter->Value));
        }
    } else if (Count >= 3) {
        ml_map_insert(Styles, ml_deref(Args[1]), ml_deref(Args[2]));
    }
    return (ml_value_t *)W;
}

static ml_value_t *app_json_fn(void *Data, int Count, ml_value_t **Args) {
    ml_ui_app_t *App = (ml_ui_app_t *)ml_deref(Args[0]);
    return ml_string(App->JsonString, (int)App->JsonLength);
}

static ml_value_t *app_show_fn(void *Data, int Count, ml_value_t **Args) {
    return ui_show_fn(NULL, 1, Args);
}

static ml_value_t *widget_show_fn(void *Data, int Count, ml_value_t **Args) {
    return ui_show_fn(NULL, 1, Args);
}

/* Global `exec` function: encoded as external ["^", "exec"] by minijs for browser execution */
static ml_value_t *mlk_exec_fn(void *Data, int Count, ml_value_t **Args) {
    return ml_error("RuntimeError", "exec() is executed asynchronously inside a browser Minilang UI (use inside a ui::button / event callback or ui::compile closure)");
}

void ml_ui_init(stringmap_t *Globals, ml_ui_emit_fn emit_fn) {
    g_ui_emit = emit_fn;

    ml_type_init(MLUIWidgetT, NULL);
    ml_type_init(MLUIAppT, NULL);

    ml_typed_fn_set(MLUIWidgetT, (void *)ml_minijs_encode, (void *)ml_ui_widget_minijs_encode);
    ml_typed_fn_set(MLUIAppT, (void *)ml_minijs_encode, (void *)ml_ui_app_minijs_encode);

    /* Widget methods */
    ml_method_by_name("on", NULL, widget_on_fn, MLUIWidgetT, MLStringT, MLFunctionT, NULL);
    ml_method_by_name("on_click", "click", widget_on_event_fixed, MLUIWidgetT, MLFunctionT, NULL);
    ml_method_by_name("on_change", "change", widget_on_event_fixed, MLUIWidgetT, MLFunctionT, NULL);
    ml_method_by_name("on_input", "input", widget_on_event_fixed, MLUIWidgetT, MLFunctionT, NULL);
    ml_method_by_name("on_submit", "submit", widget_on_event_fixed, MLUIWidgetT, MLFunctionT, NULL);
    ml_method_by_name("append", NULL, widget_append_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("add", NULL, widget_append_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("clear", NULL, widget_clear_fn, MLUIWidgetT, NULL);
    ml_method_by_name("value", "value", widget_get_prop_fn, MLUIWidgetT, NULL);
    ml_method_by_name("set_value", "value", widget_set_prop_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("text", "text", widget_get_prop_fn, MLUIWidgetT, NULL);
    ml_method_by_name("set_text", "text", widget_set_prop_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("html", "html", widget_get_prop_fn, MLUIWidgetT, NULL);
    ml_method_by_name("set_html", "html", widget_set_prop_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("set_disabled", "disabled", widget_set_prop_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("set_visible", "visible", widget_set_prop_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("set_style", NULL, widget_set_style_fn, MLUIWidgetT, MLAnyT, NULL);
    ml_method_by_name("set_style", NULL, widget_set_style_fn, MLUIWidgetT, MLStringT, MLAnyT, NULL);
    ml_method_by_name("show", NULL, widget_show_fn, MLUIWidgetT, NULL);
    ml_method_by_name("json", NULL, app_json_fn, MLUIAppT, NULL);
    ml_method_by_name("show", NULL, app_show_fn, MLUIAppT, NULL);

    /* Constructors */
    ml_value_t *fn_vbox     = ml_cfunction(NULL, ui_vbox_fn);
    ml_value_t *fn_hbox     = ml_cfunction(NULL, ui_hbox_fn);
    ml_value_t *fn_grid     = ml_cfunction(NULL, ui_grid_fn);
    ml_value_t *fn_card     = ml_cfunction(NULL, ui_card_fn);
    ml_value_t *fn_panel    = ml_cfunction(NULL, ui_panel_fn);
    ml_value_t *fn_form     = ml_cfunction(NULL, ui_form_fn);
    ml_value_t *fn_tabs     = ml_cfunction(NULL, ui_tabs_fn);
    ml_value_t *fn_text     = ml_cfunction(NULL, ui_text_fn);
    ml_value_t *fn_label    = ml_cfunction(NULL, ui_label_fn);
    ml_value_t *fn_heading  = ml_cfunction(NULL, ui_heading_fn);
    ml_value_t *fn_html     = ml_cfunction(NULL, ui_html_fn);
    ml_value_t *fn_divider  = ml_cfunction(NULL, ui_divider_fn);
    ml_value_t *fn_badge    = ml_cfunction(NULL, ui_badge_fn);
    ml_value_t *fn_code     = ml_cfunction(NULL, ui_code_fn);
    ml_value_t *fn_input    = ml_cfunction(NULL, ui_input_fn);
    ml_value_t *fn_password = ml_cfunction(NULL, ui_password_fn);
    ml_value_t *fn_textarea = ml_cfunction(NULL, ui_textarea_fn);
    ml_value_t *fn_number   = ml_cfunction(NULL, ui_number_fn);
    ml_value_t *fn_slider   = ml_cfunction(NULL, ui_slider_fn);
    ml_value_t *fn_checkbox = ml_cfunction(NULL, ui_checkbox_fn);
    ml_value_t *fn_select   = ml_cfunction(NULL, ui_select_fn);
    ml_value_t *fn_radio    = ml_cfunction(NULL, ui_radio_fn);
    ml_value_t *fn_date     = ml_cfunction(NULL, ui_date_fn);
    ml_value_t *fn_color    = ml_cfunction(NULL, ui_color_fn);
    ml_value_t *fn_button   = ml_cfunction(NULL, ui_button_fn);
    ml_value_t *fn_compile  = ml_cfunction(NULL, ui_compile_fn);
    ml_value_t *fn_show     = ml_cfunction(NULL, ui_show_fn);
    ml_value_t *fn_exec     = ml_cfunction(NULL, mlk_exec_fn);

    ml_value_t *UIModule = ml_module("ui",
        "widget",   MLUIWidgetT,
        "compiled", MLUIAppT,
        "vbox",     fn_vbox,
        "column",   fn_vbox,
        "hbox",     fn_hbox,
        "row",      fn_hbox,
        "grid",     fn_grid,
        "card",     fn_card,
        "panel",    fn_panel,
        "box",      fn_panel,
        "form",     fn_form,
        "tabs",     fn_tabs,
        "text",     fn_text,
        "label",    fn_label,
        "heading",  fn_heading,
        "html",     fn_html,
        "divider",  fn_divider,
        "badge",    fn_badge,
        "code",     fn_code,
        "pre",      fn_code,
        "input",    fn_input,
        "text_input", fn_input,
        "password", fn_password,
        "textarea", fn_textarea,
        "number",   fn_number,
        "slider",   fn_slider,
        "range",    fn_slider,
        "checkbox", fn_checkbox,
        "select",   fn_select,
        "radio",    fn_radio,
        "date",     fn_date,
        "color",    fn_color,
        "button",   fn_button,
        "compile",  fn_compile,
        "show",     fn_show,
        NULL
    );

    stringmap_insert(Globals, "ui", UIModule);
    stringmap_insert(Globals, "exec", fn_exec);

    /* Register ui module, constructors, and exec in MLExternals for minijs encoding */
    ml_externals_default_add("ui", UIModule);
    ml_externals_default_add("ui::vbox", fn_vbox);
    ml_externals_default_add("ui::hbox", fn_hbox);
    ml_externals_default_add("ui::grid", fn_grid);
    ml_externals_default_add("ui::card", fn_card);
    ml_externals_default_add("ui::panel", fn_panel);
    ml_externals_default_add("ui::form", fn_form);
    ml_externals_default_add("ui::tabs", fn_tabs);
    ml_externals_default_add("ui::text", fn_text);
    ml_externals_default_add("ui::label", fn_label);
    ml_externals_default_add("ui::heading", fn_heading);
    ml_externals_default_add("ui::html", fn_html);
    ml_externals_default_add("ui::divider", fn_divider);
    ml_externals_default_add("ui::badge", fn_badge);
    ml_externals_default_add("ui::code", fn_code);
    ml_externals_default_add("ui::input", fn_input);
    ml_externals_default_add("ui::password", fn_password);
    ml_externals_default_add("ui::textarea", fn_textarea);
    ml_externals_default_add("ui::number", fn_number);
    ml_externals_default_add("ui::slider", fn_slider);
    ml_externals_default_add("ui::checkbox", fn_checkbox);
    ml_externals_default_add("ui::select", fn_select);
    ml_externals_default_add("ui::radio", fn_radio);
    ml_externals_default_add("ui::date", fn_date);
    ml_externals_default_add("ui::color", fn_color);
    ml_externals_default_add("ui::button", fn_button);
    ml_externals_default_add("ui::compile", fn_compile);
    ml_externals_default_add("ui::show", fn_show);
    ml_externals_default_add("exec", fn_exec);
}
