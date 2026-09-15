//! The per-phase wall-clock breakdown `--timings` prints.
//!
//! A phase is one span of a run the reader can act on: the file walk, the rules, the
//! `compact format --check` subprocess. Each carries a detail column naming what it
//! worked on, so a slow phase says why it was slow.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use crate::diagnostic::duration;

/// The block's first line.
const HEADING: &str = "Timings";

/// The name of the closing row.
const TOTAL: &str = "total";

/// Indentation under the heading.
const INDENT: &str = "  ";

/// Separator between columns.
const GAP: &str = "  ";

/// Width of the share column, sized for `100.0%`.
const SHARE_WIDTH: usize = 6;

/// A phase being measured, recorded where it ends.
#[derive(Debug)]
pub struct Phase {
    name: &'static str,
    started: Instant,
}

impl Phase {
    /// Opens a phase named `name`.
    #[must_use]
    pub fn start(name: &'static str) -> Self {
        Self {
            name,
            started: Instant::now(),
        }
    }

    /// Ends the phase now and records it.
    pub fn stop(self, timings: &mut Timings, detail: impl Into<String>) {
        timings.record(self.name, self.started.elapsed(), detail);
    }
}

/// One recorded phase.
#[derive(Debug)]
struct Measured {
    name: &'static str,
    elapsed: Duration,
    detail: String,
}

/// Every phase of one run, in the order it was recorded.
#[derive(Debug, Default)]
pub struct Timings {
    phases: Vec<Measured>,
}

impl Timings {
    /// Records a phase the caller timed itself, for work spread over a loop.
    pub fn record(&mut self, name: &'static str, elapsed: Duration, detail: impl Into<String>) {
        self.phases.push(Measured {
            name,
            elapsed,
            detail: detail.into(),
        });
    }

    /// Renders the block, longest phase first and the total last.
    ///
    /// The total is the sum of the phases, not the run's wall clock, so a phase nobody
    /// measured is missing from both.
    #[must_use]
    pub fn render(&self) -> String {
        let total: Duration = self.phases.iter().map(|phase| phase.elapsed).sum();

        let mut rows: Vec<(&Measured, String)> = self
            .phases
            .iter()
            .map(|phase| (phase, duration(phase.elapsed)))
            .collect();
        // Sorting is stable, so phases of equal length stay in the order they ran.
        rows.sort_by_key(|(phase, _)| std::cmp::Reverse(phase.elapsed));

        let total_elapsed = duration(total);
        let name_width = rows
            .iter()
            .map(|(phase, _)| phase.name.len())
            .chain([TOTAL.len()])
            .max()
            .unwrap_or_default();
        // Padding counts characters, so a microsecond figure must be measured the same way.
        let elapsed_width = rows
            .iter()
            .map(|(_, elapsed)| elapsed.chars().count())
            .chain([total_elapsed.chars().count()])
            .max()
            .unwrap_or_default();

        let mut out = HEADING.to_owned();
        for (phase, elapsed) in &rows {
            let line = format!(
                "{INDENT}{name:<name_width$}{GAP}{elapsed:>elapsed_width$}{GAP}{share:>SHARE_WIDTH$}{GAP}{detail}",
                name = phase.name,
                share = share(phase.elapsed, total),
                detail = phase.detail,
            );
            let _ = write!(out, "\n{}", line.trim_end());
        }
        let _ = write!(
            out,
            "\n{INDENT}{TOTAL:<name_width$}{GAP}{total_elapsed:>elapsed_width$}"
        );
        out
    }
}

/// A phase's share of the total, `0.0%` for a run that measured nothing.
fn share(elapsed: Duration, total: Duration) -> String {
    let share = if total.is_zero() {
        0.0
    } else {
        elapsed.as_secs_f64() / total.as_secs_f64() * 100.0
    };
    format!("{share:.1}%")
}

#[cfg(test)]
mod tests {
    use super::{Phase, Timings};
    use std::time::Duration;

    fn timings() -> Timings {
        let mut timings = Timings::default();
        timings.record(
            "config and walk",
            Duration::from_millis(1),
            "39 files matched",
        );
        timings.record(
            "parse and rules",
            Duration::from_millis(40),
            "39 files, 512 issues",
        );
        timings.record(
            "format check",
            Duration::from_millis(3_200),
            "compact format --check, 39 files, 1 process",
        );
        timings
    }

    #[test]
    fn phases_render_longest_first_with_the_total_last() {
        let rendered = timings().render();

        let names: Vec<&str> = rendered
            .lines()
            .skip(1)
            .filter_map(|line| line.split_whitespace().next())
            .collect();
        assert_eq!(names, ["format", "parse", "config", "total"]);
    }

    #[test]
    fn the_columns_line_up_and_the_shares_sum_to_the_whole() {
        assert_eq!(
            timings().render(),
            "Timings\n\
             \x20 format check     3.2s   98.7%  compact format --check, 39 files, 1 process\n\
             \x20 parse and rules  40ms    1.2%  39 files, 512 issues\n\
             \x20 config and walk   1ms    0.0%  39 files matched\n\
             \x20 total            3.2s"
        );
    }

    #[test]
    fn a_microsecond_phase_keeps_the_columns_aligned() {
        let mut timings = Timings::default();
        timings.record("parse and rules", Duration::from_millis(52), "39 files");
        timings.record("render", Duration::from_micros(299), "20 diagnostics shown");

        assert_eq!(
            timings.render(),
            "Timings\n\
             \x20 parse and rules   52ms   99.4%  39 files\n\
             \x20 render           299\u{b5}s    0.6%  20 diagnostics shown\n\
             \x20 total             52ms"
        );
    }

    #[test]
    fn a_phase_without_a_detail_leaves_no_trailing_space() {
        let mut timings = Timings::default();
        timings.record("render", Duration::from_millis(2), "");

        assert_eq!(
            timings.render(),
            "Timings\n  render  2ms  100.0%\n  total   2ms"
        );
    }

    #[test]
    fn a_run_that_measured_nothing_renders_a_zero_total() {
        let mut timings = Timings::default();
        Phase::start("config and walk").stop(&mut timings, "0 files matched");

        let rendered = timings.render();
        assert!(rendered.starts_with("Timings\n"), "{rendered}");
        assert!(rendered.contains("0 files matched"), "{rendered}");
    }
}
