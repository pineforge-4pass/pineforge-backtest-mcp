/* Synthetic C ABI boundary only: not the PineForge engine or a release image. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef PF_ABI_VERSION
#error "PF_ABI_VERSION must be supplied by the fixture compiler"
#endif

#if PF_ABI_VERSION >= 5

/* Public boundary from the v1.13.0 amd64 pineforge.h. ABI 5 requires a
 * module rebuild but keeps the ABI 4 report and trade layouts. */
typedef enum pf_magnifier_distribution_e {
    PF_MAGNIFIER_UNIFORM = 0,
    PF_MAGNIFIER_COSINE = 1,
    PF_MAGNIFIER_TRIANGLE = 2,
    PF_MAGNIFIER_ENDPOINTS = 3,
    PF_MAGNIFIER_FRONT_LOADED = 4,
    PF_MAGNIFIER_BACK_LOADED = 5
} pf_magnifier_distribution_t;

typedef struct pf_bar_s {
    double open;
    double high;
    double low;
    double close;
    double volume;
    int64_t timestamp;
} pf_bar_t;

typedef struct pf_trade_s {
    int64_t entry_time;
    int64_t exit_time;
    double entry_price;
    double exit_price;
    double pnl;
    double pnl_pct;
    int is_long;
    double max_runup;
    double max_drawdown;
    double qty;
    double commission;
    int32_t entry_bar_index;
    int32_t exit_bar_index;
    int32_t open_at_end;
} pf_trade_t;

typedef struct pf_trade_stats_s {
    int32_t num_trades;
    int32_t num_wins;
    int32_t num_losses;
    int32_t num_even;
    double percent_profitable;
    double net_profit;
    double net_profit_pct;
    double gross_profit;
    double gross_profit_pct;
    double gross_loss;
    double gross_loss_pct;
    double profit_factor;
    double avg_trade;
    double avg_trade_pct;
    double avg_win;
    double avg_win_pct;
    double avg_loss;
    double avg_loss_pct;
    double ratio_avg_win_avg_loss;
    double largest_win;
    double largest_win_pct;
    double largest_loss;
    double largest_loss_pct;
    double commission_paid;
    double expectancy;
    int32_t max_consecutive_wins;
    int32_t max_consecutive_losses;
    double avg_bars_in_trade;
    double avg_bars_in_wins;
    double avg_bars_in_losses;
} pf_trade_stats_t;

typedef struct pf_equity_stats_s {
    double max_equity_drawdown;
    double max_equity_drawdown_pct;
    double max_equity_runup;
    double max_equity_runup_pct;
    double buy_hold_return;
    double buy_hold_return_pct;
    double sharpe_monthly;
    double sortino_monthly;
    double sharpe_bar;
    double sortino_bar;
    double cagr;
    double calmar;
    double recovery_factor;
    double time_in_market_pct;
    double open_pl;
} pf_equity_stats_t;

typedef struct pf_metrics_s {
    pf_trade_stats_t all, longs, shorts;
    pf_equity_stats_t equity;
} pf_metrics_t;

typedef struct pf_equity_point_s {
    int64_t time_ms;
    double equity;
    double open_profit;
} pf_equity_point_t;

typedef struct pf_security_diag_s {
    int sec_id;
    int64_t feed_count;
    int64_t complete_count;
    int64_t partial_count;
} pf_security_diag_t;

typedef struct pf_trace_entry_s {
    int64_t timestamp;
    int32_t bar_index;
    int32_t name_id;
    double value;
} pf_trace_entry_t;

typedef struct pf_report_s {
    int total_trades;
    pf_trade_t *trades;
    int trades_len;
    double net_profit;
    int64_t input_bars_processed;
    int64_t script_bars_processed;
    int64_t security_feeds_total;
    int64_t security_complete_total;
    int64_t security_partial_total;
    int64_t magnifier_sub_bars_total;
    int64_t magnifier_sample_ticks_total;
    int input_tf_seconds;
    int script_tf_seconds;
    int script_tf_ratio;
    int needs_aggregation;
    int bar_magnifier_enabled;
    pf_security_diag_t *security_diag;
    int security_diag_len;
    pf_trace_entry_t *trace;
    int trace_len;
    const char **trace_names;
    int trace_names_len;
    pf_metrics_t metrics;
    pf_equity_point_t *equity_curve;
    int64_t equity_curve_len;
    uint64_t *broker_state_hash;
    int64_t broker_state_hash_len;
} pf_report_t;

typedef void *pf_strategy_t;

/* Generated-strategy settings extension from the same pinned header. */
#define PF_SETTINGS_API_VERSION 1u

typedef enum pf_settings_status_t {
    PF_SETTINGS_OK = 0,
    PF_SETTINGS_INVALID_ARGUMENT = 1,
    PF_SETTINGS_UNSUPPORTED = 2,
    PF_SETTINGS_EXCEPTION = 3,
    PF_SETTINGS_BUFFER_TOO_SMALL = 4,
    PF_SETTINGS_RUN_FAILED = 5
} pf_settings_status_t;

static const pf_strategy_t fixture_state = (void *)(uintptr_t)1;
static int state_live;
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

int pf_abi_version(void) { return PF_ABI_VERSION; }
pf_strategy_t strategy_create(const char *params) {
    (void)params;
    refused = 0;
    ran = 0;
    state_live = 1;
    record("create");
    return fixture_state;
}
void strategy_free(pf_strategy_t state) {
    if (state == fixture_state) state_live = 0;
    if (state) record("state_free");
}

uint32_t strategy_settings_api_version(void) { return PF_SETTINGS_API_VERSION; }

int strategy_get_effective_settings(pf_strategy_t state, char *json,
                                    size_t capacity, size_t *required,
                                    char *error, size_t error_capacity) {
    /* The fixed Pine source only declares the strategy. Period=0 is an
     * injected request for the legacy setter, not a declared input. */
    static const char receipt[] = "{\"inputs\":[],\"overrides\":[]}";

    if (!state_live || state != fixture_state || !required) {
        if (error && error_capacity)
            snprintf(error, error_capacity, "%s", "live strategy and required length pointer needed");
        return PF_SETTINGS_INVALID_ARGUMENT;
    }

    *required = sizeof(receipt);
    if (!json || capacity < *required) {
        if (error && error_capacity)
            snprintf(error, error_capacity, "%s", "settings receipt buffer too small");
        return PF_SETTINGS_BUFFER_TOO_SMALL;
    }

    memcpy(json, receipt, sizeof(receipt));
    if (error && error_capacity) error[0] = '\0';
    return PF_SETTINGS_OK;
}
void report_free(pf_report_t *report) {
    /* The failed runs leave no allocated report arrays. */
    if (report) record("report_free");
}

void strategy_set_input(pf_strategy_t state, const char *name, const char *value) {
    if (!state || !name || !value) abort();
    if (strcmp(name, "Period") == 0 && strcmp(value, "0") == 0) {
        refused = 1;
        record("setting_refused:Period=0");
    }
}

void run_backtest_full(pf_strategy_t state, pf_bar_t *bars, int count,
                       const char *input_tf, const char *script_tf,
                       int magnifier, int samples, pf_magnifier_distribution_t distribution,
                       pf_report_t *report) {
    (void)magnifier;
    (void)samples;
    (void)distribution;
    if (!state || !bars || count != 3 || !input_tf || !script_tf || !report) abort();
    *report = (pf_report_t){0};
    ran = 1;
    record("run:3_bars");
}

const char *strategy_get_last_error(pf_strategy_t state) {
    if (!state) return NULL;
    if (!ran) return "fixture did not execute the backtest";
    if (is_case("refused")) {
        return refused ? "input Period: value 0 is below minimum 1"
                       : "fixture did not receive the refused setting";
    }
    return "";
}
const char *strategy_get_last_error_code(pf_strategy_t state) {
    if (!state) return NULL;
    if (!ran) return "";
    if (is_case("empty")) return "strategy_runtime_error";
    if (is_case("refused") && refused) return "setting_rejected";
    return "";
}
const char *strategy_get_last_error_args(pf_strategy_t state) {
    if (!state) return NULL;
    if (!ran) return "";
    if (is_case("refused")) return refused ? "{\"input\":\"Period\"}" : "";
    return "{\"message\":\"\"}";
}
int strategy_last_run_status(pf_strategy_t state) {
    if (!state) return -1;
    return ran ? 1 : 0;
}

#else

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

int pf_abi_version(void) { return PF_ABI_VERSION; }
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

#endif
