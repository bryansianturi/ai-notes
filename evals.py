"""Score the summariser against fixed test notes.

Usage: python evals.py [model]
"""

import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import main

EVALS_DIR = Path(__file__).parent / "evals"
CASES = json.loads((EVALS_DIR / "cases.json").read_text())
RESULTS_DIR = EVALS_DIR / "results"
PASS_THRESHOLD = 0.8  # the run fails if fewer than 80% of cases pass
MAX_WORDS = 30
PREAMBLES = ("here is", "here's", "summary:", "sure")


def check(case: dict, summary: str) -> dict[str, bool]:
    s = summary.strip()
    lower = s.lower()
    return {
        "non_empty": bool(s),
        "shorter": len(s) < len(case["note"]),
        "max_words": len(s.split()) <= MAX_WORDS,
        "one_sentence": len(re.findall(r"[.!?](?:\s|$)", s)) <= 1,
        "no_preamble": not lower.startswith(PREAMBLES),
        "keywords": all(k.lower() in lower for k in case["must_mention"]),
    }


def run(model: str) -> None:
    print(f"Model {model} · prompt {main.PROMPT_VERSION} · {len(CASES)} cases\n")
    results = []

    for case in CASES:
        start = time.perf_counter()
        data = main.ask_ollama(case["note"], model=model)
        seconds = time.perf_counter() - start

        summary = data["message"]["content"].strip()
        checks = check(case, summary)
        passed = all(checks.values())
        failed = [name for name, ok in checks.items() if not ok]

        print(
            f"{'PASS' if passed else 'FAIL'}  {case['id']:<17} {seconds:5.1f}s  {', '.join(failed)}"
        )
        results.append(
            {
                "id": case["id"],
                "summary": summary,
                "checks": checks,
                "passed": passed,
                "seconds": round(seconds, 2),
                "tokens": data.get("eval_count", 0),
            }
        )

    passed_count = sum(r["passed"] for r in results)
    pass_rate = passed_count / len(results)
    avg_seconds = sum(r["seconds"] for r in results) / len(results)
    print(
        f"\nPassed {passed_count}/{len(results)} ({pass_rate:.0%}) · avg {avg_seconds:.1f}s per summary"
    )

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = RESULTS_DIR / f"{model.replace(':', '_')}-{main.PROMPT_VERSION}-{stamp}.json"
    out.write_text(
        json.dumps(
            {
                "model": model,
                "prompt_version": main.PROMPT_VERSION,
                "prompt": main.SYSTEM_PROMPT,
                "pass_rate": pass_rate,
                "avg_seconds": round(avg_seconds, 2),
                "results": results,
            },
            indent=2,
        )
    )
    print(f"Saved {out}")

    if pass_rate < PASS_THRESHOLD:
        sys.exit(1)  # a non-zero exit makes CI go red


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else main.MODEL)
