"""Synthetic transpiler boundary for the compiled ABI fixture, not Pine codegen."""

__version__ = "synthetic-boundary-fixture"


def transpile(source, *, filename):
    if 'strategy("REL140 boundary C ABI stand-in")' not in source:
        raise ValueError("fixture source marker missing")
    if filename != "strategy.pine":
        raise ValueError("unexpected fixture filename")
    # pf_parity's unchanged g++ command links the cc-built stand-in archive.
    return "// Synthetic boundary fixture; no Pine translation claim.\nint fixture_translation_unit;\n"
