/* Synthetic C ABI boundary only: not the PineForge engine or a release image. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int refused;
static int ran;

static void record(const char *event) {
    const char *path = getenv("PF_BOUNDARY_ABI_LOG");
    if (!path) abort();
    FILE *file = fopen(path, "a");
    if (!file) abort();
    fprintf(file, "%s\n", event);
    fclose(file);
}

static int is_case(const char *name) {
    const char *mode = getenv("PF_BOUNDARY_CASE");
    return mode && strcmp(mode, name) == 0;
}

int pf_abi_version(void) { return 4; }
void *strategy_create(const char *params) {
    (void)params;
    refused = 0;
    ran = 0;
    record("create");
    return (void *)(uintptr_t)1;
}
void strategy_free(void *state) { (void)state; record("state_free"); }
void report_free(void *report) { (void)report; record("report_free"); }

int strategy_set_input(void *state, const char *name, const char *value) {
    (void)state;
    if (strcmp(name, "Period") == 0 && strcmp(value, "0") == 0) {
        refused = 1;
        record("setting_refused:Period=0");
        return -1;
    }
    return 0;
}

void run_backtest_full(void *state, const void *bars, int count,
                       const char *input_tf, const char *script_tf,
                       int magnifier, int samples, int distribution, void *report) {
    (void)state; (void)input_tf; (void)script_tf; (void)magnifier;
    (void)samples; (void)distribution; (void)report;
    if (!bars || count != 3) abort();
    ran = 1;
    record("run:3_bars");
}

const char *strategy_get_last_error(void *state) {
    (void)state;
    if (!ran) return "fixture did not execute the backtest";
    if (is_case("refused")) {
        return refused ? "input Period: value 0 is below minimum 1"
                       : "fixture did not receive the refused setting";
    }
    return "";
}
const char *strategy_get_last_error_code(void *state) {
    (void)state;
    if (is_case("empty")) return "strategy_runtime_error";
    if (is_case("refused") && refused) return "setting_rejected";
    return "";
}
const char *strategy_get_last_error_args(void *state) {
    (void)state;
    return is_case("refused") ? "{\"input\":\"Period\"}" : "{\"message\":\"\"}";
}
int strategy_last_run_status(void *state) { (void)state; return ran ? 1 : 0; }
