`tv_trades.csv` is `validation/risk-max-contracts-held-gate-pyramid-01/tv_trades.csv` from
[pineforge-corpus](https://github.com/pineforge-4pass/pineforge-corpus) at a35c7c4
(Apache-2.0), unchanged: a TradingView "List of trades" export with its BOM, exit rows
before entry rows, and no final newline.

`xlsx.ts` builds Strategy Tester report workbooks for the tests. TradingView does not
document the XLSX layout; the builder follows what its report shows: the sheets
Performance, Trades analysis, Risk performance ratios, List of trades and Properties; the
List of trades header equal to the CSV's, with "Date and time" as an Excel date serial in a
date format; Properties as name/value rows under the sections Date range, Symbol info,
Strategy inputs and Strategy properties.
