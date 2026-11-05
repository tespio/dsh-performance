"""Render the benchmark chart from results/summary.json.

Usage: python charts/make_charts.py
Requires matplotlib (see requirements.txt).
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator

ROOT = Path(__file__).resolve().parent.parent
SUMMARY = ROOT / "results" / "summary.json"
CHARTS = ROOT / "charts"

BASELINE = "#64748b"
BASELINE_FILL = "#f8fafc"
PATCHED = "#2563eb"
CONNECTOR = "#cbd5e1"
INK = "#0f172a"
MUTED = "#64748b"
GRID = "#e2e8f0"

LABELS = {
    "accessor-read": "context accessor read (ctx.on)",
    "service-call": "service call (ctx.svc.method())",
    "emit-0": "emit — 0 listeners",
    "emit-1": "emit — 1 listener",
    "emit-5": "emit — 5 listeners",
    "emit-20": "emit — 20 listeners",
    "events-emit-5": "events.emit — 5 listeners",
    "dispatch-5": "dispatch — 5 listeners",
    "waterfall-5": "waterfall — 5 listeners",
    "effect-noop": "effect registration",
    "logger-suppressed": "logger call (suppressed)",
}


def load() -> dict:
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    for case in summary["cases"]:
        case["name"] = LABELS.get(case["id"], case["label"])
    return summary


def machine_note(meta: dict) -> str:
    platform = "Windows" if str(meta["platform"]).startswith("win32") else str(meta["platform"])
    return (
        f"{platform} · {meta['cpu']} · {meta['cores']} threads · "
        f"Node {str(meta['node']).lstrip('v')} · median of {meta['rounds']} rounds"
    )


def us(nanoseconds: float) -> float:
    return nanoseconds / 1000


def draw_before_after(summary: dict) -> None:
    cases = sorted(summary["cases"], key=lambda case: case["speedup"])
    names = [case["name"] for case in cases]
    positions = range(len(cases))

    figure, ax = plt.subplots(figsize=(10.6, 5.6), dpi=200)

    for index, case in enumerate(cases):
        before = us(case["base"]["median"])
        after = us(case["patched"]["median"])
        ax.plot([before, after], [index, index], color=CONNECTOR, linewidth=2.4, zorder=1, solid_capstyle="round")

        for series, color, fill in (
            (case["base"], BASELINE, BASELINE_FILL),
            (case["patched"], PATCHED, PATCHED),
        ):
            median = us(series["median"])
            low = us(series["p25"])
            high = us(series["p75"])
            ax.errorbar(
                [median], [index],
                xerr=[[median - low], [high - median]],
                fmt="none", ecolor=color, elinewidth=1, capsize=2.5, alpha=0.55, zorder=2,
            )

        ax.scatter([before], [index], s=64, facecolor=BASELINE_FILL, edgecolor=BASELINE, linewidth=1.6, zorder=3)
        ax.scatter([after], [index], s=64, color=PATCHED, zorder=4)

        # Right-hand columns: exact pair, then the ratio.
        ax.text(
            1.02, index, f"{before:.2f} → {after:.2f} µs",
            transform=ax.get_yaxis_transform(), va="center", fontsize=8.5, color=MUTED,
        )
        ax.text(
            1.27, index, f"{case['speedup']:.1f}×",
            transform=ax.get_yaxis_transform(), va="center", fontsize=10, color=PATCHED, fontweight="bold",
        )

    ax.text(1.02, len(cases) - 0.32, "cost before → after", transform=ax.get_yaxis_transform(),
            fontsize=8, color=MUTED, va="center")
    ax.text(1.27, len(cases) - 0.32, "speedup", transform=ax.get_yaxis_transform(),
            fontsize=8, color=MUTED, va="center")

    ax.set_xscale("log")
    ax.set_xlim(0.4, 55)
    ax.xaxis.set_major_locator(FixedLocator([0.5, 1, 2, 5, 10, 20, 50]))
    ax.xaxis.set_minor_locator(NullLocator())
    ax.xaxis.set_major_formatter(FuncFormatter(lambda value, _: f"{value:g} µs"))
    ax.set_yticks(list(positions))
    ax.set_yticklabels(names, color=INK)
    ax.set_ylim(-0.8, len(cases) - 0.05)
    ax.set_xlabel("cost per operation (log scale)", color=MUTED, fontsize=9)

    ax.set_title(
        "Before and after, per operation",
        loc="left",
        fontsize=15,
        color=INK,
        fontweight="bold",
        pad=30,
    )
    ax.text(
        0, 1.035, machine_note(summary["meta"]),
        transform=ax.transAxes, fontsize=8.5, color=MUTED, va="bottom",
    )

    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(axis="x", color=GRID, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(colors=MUTED, labelsize=9, length=0)

    ax.legend(
        handles=[
            Line2D([], [], marker="o", linestyle="none", markersize=7, markerfacecolor=BASELINE_FILL,
                   markeredgecolor=BASELINE, markeredgewidth=1.6, label="before"),
            Line2D([], [], marker="o", linestyle="none", markersize=7, color=PATCHED, label="after"),
        ],
        frameon=False, loc="upper center", bbox_to_anchor=(0.35, -0.09), ncol=2,
        fontsize=9, labelcolor=MUTED, handletextpad=0.2, columnspacing=2.2,
    )

    figure.text(
        0.01, 0.01,
        "Dots are medians; whiskers are p25–p75 over 7 alternating rounds in one process. "
        "Baseline: DSH vendored Cordis 4.0.6-alpha.1. Patched: same sources + patch/0001-cordis-hot-paths.patch.",
        fontsize=7.2, color=MUTED,
    )
    figure.subplots_adjust(left=0.30, right=0.80, top=0.84, bottom=0.20)
    figure.savefig(CHARTS / "before-after.png", facecolor="white", bbox_inches="tight", pad_inches=0.25)
    figure.savefig(CHARTS / "before-after.svg", facecolor="white", bbox_inches="tight", pad_inches=0.25)
    plt.close(figure)


def draw_end_to_end() -> None:
    data = json.loads((ROOT / "results" / "end-to-end" / "summary.json").read_text(encoding="utf-8"))
    pairs = data["pairs"]
    metrics = data["metrics"]
    turn = metrics["turnExecutionMs"]
    base = [pair["baseMs"] for pair in pairs]
    patched = [pair["patchedMs"] for pair in pairs]
    median_base = turn["baseMedian"]
    median_patched = turn["patchedMedian"]
    relative = turn["medianRelativePct"]
    paired_delta = turn["medianDiff"]
    faster = turn["fasterPairs"]
    total_pairs = turn["pairs"]

    figure, ax = plt.subplots(figsize=(7.4, 5.8), dpi=200)

    for pair in pairs:
        ax.plot([0, 1], [pair["baseMs"], pair["patchedMs"]], color=CONNECTOR, linewidth=1.1, alpha=0.65, zorder=1,
                solid_capstyle="round")
    ax.plot([0, 1], [median_base, median_patched], color=INK, linewidth=2.4, zorder=5, solid_capstyle="round")
    ax.scatter([0], [median_base], s=130, facecolor=BASELINE_FILL, edgecolor=BASELINE, linewidth=2, zorder=6)
    ax.scatter([1], [median_patched], s=130, color=PATCHED, zorder=6)

    ax.annotate(f"median {median_base / 1000:.2f} s", (0, median_base), textcoords="offset points", xytext=(-14, 8),
                ha="right", fontsize=9, color=MUTED)
    ax.annotate(f"median {median_patched / 1000:.2f} s", (1, median_patched), textcoords="offset points", xytext=(14, -14),
                ha="left", fontsize=9, color=PATCHED)
    ax.annotate(
        f"{relative:+.1f}%\n({paired_delta:+.0f} ms paired)", (1, median_patched),
        textcoords="offset points", xytext=(20, 26), ha="left", fontsize=10, color=INK, fontweight="bold",
    )

    ax.set_xlim(-0.55, 1.75)
    low = min(min(base), min(patched))
    high = max(max(base), max(patched))
    ax.set_ylim(low - 90, high + 90)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["before", "after"], color=INK, fontsize=11)
    ax.set_ylabel("turn execution time — 100 turns (ms)", color=MUTED, fontsize=9)

    ax.set_title(
        "End-to-end: 100 SDK turns, before and after",
        loc="left", fontsize=14, color=INK, fontweight="bold", pad=28,
    )
    ax.text(
        0, 1.035,
        f"sdk-minimal profile · 200 model requests · 800 tool calls · {total_pairs} paired runs · "
        f"{'Windows' if str(data['meta']['platform']).startswith('win32') else data['meta']['platform']}, Node "
        f"{str(data['meta']['node']).lstrip('v')}",
        transform=ax.transAxes, fontsize=8.5, color=MUTED, va="bottom",
    )

    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(axis="y", color=GRID, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(colors=MUTED, labelsize=9, length=0)

    figure.text(
        0.01, 0.01,
        f"Each thin line is one paired run; the thicker line connects medians. "
        f"{faster}/{total_pairs} runs finished faster with the patch; boot time was unchanged. "
        f"Only vendor/cordis/lib differs between arms.",
        fontsize=7.2, color=MUTED,
    )
    figure.subplots_adjust(left=0.14, right=0.94, top=0.84, bottom=0.16)
    figure.savefig(CHARTS / "end-to-end.png", facecolor="white", bbox_inches="tight", pad_inches=0.2)
    figure.savefig(CHARTS / "end-to-end.svg", facecolor="white", bbox_inches="tight", pad_inches=0.2)
    plt.close(figure)


def draw_turn_breakdown() -> None:
    data = json.loads((ROOT / "results" / "profile" / "turn-breakdown.json").read_text(encoding="utf-8"))
    configs = sorted(data["configs"], key=lambda config: config["msPerTurn"])
    names = [config["label"] for config in configs]
    values = [config["msPerTurn"] for config in configs]
    colors = []
    for config in configs:
        if config["id"] == "parallel":
            colors.append(PATCHED)
        elif config["id"].startswith("no-tools"):
            colors.append("#93c5fd")
        else:
            colors.append(BASELINE)

    figure, ax = plt.subplots(figsize=(9.4, 4.2), dpi=200)
    bars = ax.barh(names, values, height=0.6, color=colors, zorder=3)
    for bar, value in zip(bars, values):
        ax.text(value + 0.8, bar.get_y() + bar.get_height() / 2, f"{value:.1f} ms", va="center", fontsize=9,
                color=INK, fontweight="bold")

    baseline = next(config["msPerTurn"] for config in configs if config["id"] == "serial")
    parallel = next(config["msPerTurn"] for config in configs if config["id"] == "parallel")
    ax.text(
        0.99, 0.03,
        f"concurrency-safe views: {(parallel - baseline) / baseline * 100:+.0f}% per turn",
        transform=ax.transAxes, ha="right", fontsize=9, color=PATCHED, fontweight="bold",
    )

    ax.set_xlim(0, max(values) * 1.18)
    ax.set_xlabel("turn execution per turn (ms)", color=MUTED, fontsize=9)
    ax.set_title("Where a tool-heavy turn goes", loc="left", fontsize=14, color=INK, fontweight="bold", pad=26)
    ax.text(
        0, 1.02,
        f"sdk-minimal · 8 view calls per turn · {data['meta']['turnsPerRun']}-turn runs · "
        f"medians of {data['meta']['runsPerConfig']} runs · Windows, Node {str(data['meta']['node']).lstrip('v')}",
        transform=ax.transAxes, fontsize=8.5, color=MUTED, va="bottom",
    )
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(axis="x", color=GRID, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(colors=MUTED, labelsize=9, length=0)
    ax.set_yticklabels(names, color=INK)

    figure.text(
        0.01, 0.01,
        "Only the tool-concurrency arm changes application code (a temporary isConcurrencySafe on the editor's view command); "
        "the no-compression arms change the session profile config.",
        fontsize=7.2, color=MUTED,
    )
    figure.tight_layout(rect=(0, 0.03, 1, 1))
    figure.savefig(CHARTS / "turn-breakdown.png", facecolor="white", bbox_inches="tight", pad_inches=0.2)
    figure.savefig(CHARTS / "turn-breakdown.svg", facecolor="white", bbox_inches="tight", pad_inches=0.2)
    plt.close(figure)


def draw_chain() -> None:
    data = json.loads((ROOT / "results" / "chain" / "summary.json").read_text(encoding="utf-8"))
    arms = [("base", BASELINE), ("cordis", "#7c93c9"), ("both", PATCHED)]
    names = [data["arms"][arm]["label"] for arm, _ in arms]
    values = [data["arms"][arm]["medianMs"] / 1000 for arm, _ in arms]
    colors = [color for _, color in arms]

    figure, ax = plt.subplots(figsize=(9.4, 4.6), dpi=200)
    bars = ax.barh(names, values, height=0.58, color=colors, zorder=3)
    for bar, value in zip(bars, values):
        ax.text(value + 0.06, bar.get_y() + bar.get_height() / 2, f"{value:.2f} s", va="center", fontsize=10,
                color=INK, fontweight="bold")

    speedup = data["combined"]["speedup"]
    figure.text(0.985, 0.955, f"{speedup:.1f}× overall", ha="right", va="top", fontsize=13, color=PATCHED,
                fontweight="bold")

    ax.set_xlim(0, max(values) * 1.35)
    ax.set_xlabel("turn execution for 100 turns (s, lower is better)", color=MUTED, fontsize=9)
    ax.set_title("Cumulative effect on the SDK continuation workload", loc="left", fontsize=14, color=INK,
                 fontweight="bold", pad=26)
    ax.text(
        0, 1.02,
        f"{data['meta']['rounds']} rounds per arm, rotating order · sdk-minimal · 200 requests · 800 tool calls · "
        f"Windows · Node {str(data['meta']['node']).lstrip('v')}",
        transform=ax.transAxes, fontsize=8.5, color=MUTED, va="bottom",
    )
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(axis="x", color=GRID, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(colors=MUTED, labelsize=9, length=0)
    ax.set_yticklabels(names, color=INK)

    figure.text(
        0.01, 0.01,
        "Only the two patched libraries differ between arms. The Cordis step is noisy at this sample size; its dedicated "
        "26-pair measurement is −3.1%. The tool step is measured in 10 further pairs at 1.88×.",
        fontsize=7.2, color=MUTED,
    )
    figure.tight_layout(rect=(0, 0.03, 1, 1))
    figure.savefig(CHARTS / "chain.png", facecolor="white", bbox_inches="tight", pad_inches=0.2)
    figure.savefig(CHARTS / "chain.svg", facecolor="white", bbox_inches="tight", pad_inches=0.2)
    plt.close(figure)


def main() -> None:
    summary = load()
    CHARTS.mkdir(exist_ok=True)
    draw_chain()
    draw_before_after(summary)
    draw_end_to_end()
    draw_turn_breakdown()
    print("wrote chain, before-after, end-to-end, and turn-breakdown charts")


if __name__ == "__main__":
    main()
