//! Diagnostics and the three reporters that render them.
//!
//! A [`Diagnostic`] carries everything a reporter prints: where, which rule, at which
//! [`Level`], and optionally a [`FixPreview`] rendered as a line diff.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anstyle::{AnsiColor, Color, Style};
use serde::Deserialize;
use similar::{ChangeTag, DiffTag, TextDiff};

use crate::report::{Position, RuleId};

/// Total width a header fills, rule glyphs included.
const HEADER_WIDTH: usize = 100;

/// Shortest run of header rule glyphs, whatever the header's length.
const MIN_RULE_GLYPHS: usize = 10;

/// Body indentation under a header.
const INDENT: &str = "  ";

/// Source lines shown on each side of the finding line.
const CONTEXT: usize = 2;

/// Printed when the cap hides diagnostics.
pub const TRUNCATION_NOTICE: &str =
    "The number of diagnostics exceeds the limit allowed. Use --max-diagnostics to increase it.";

/// How loudly a rule reports, and whether it runs at all.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// The rule is not run and its findings are dropped.
    Off,
    Info,
    Warn,
    #[default]
    Error,
}

impl Level {
    /// The glyph the default and concise reporters print.
    #[must_use]
    pub const fn glyph(self) -> char {
        match self {
            Self::Error => '\u{d7}',
            Self::Warn => '!',
            Self::Off | Self::Info => 'i',
        }
    }

    /// The GitHub workflow-command name.
    #[must_use]
    pub const fn github(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warning",
            Self::Off | Self::Info => "notice",
        }
    }

    const fn color(self) -> AnsiColor {
        match self {
            Self::Error => AnsiColor::Red,
            Self::Warn => AnsiColor::Yellow,
            Self::Off | Self::Info => AnsiColor::Cyan,
        }
    }
}

/// The source range a diagnostic underlines, end exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: Position,
    pub end: Position,
}

impl Span {
    #[must_use]
    pub const fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }

    /// A span covering `width` columns of one line.
    #[must_use]
    pub const fn columns(start: Position, width: usize) -> Self {
        Self {
            start,
            end: Position {
                line: start.line,
                column: start.column + width,
            },
        }
    }
}

/// The line window an edit rewrites, before and after it applies.
///
/// `first_line` is the 1-based line the window opens on. Both sides open there, because
/// the window starts at the first line the two texts differ on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixPreview {
    pub title: String,
    pub before: String,
    pub after: String,
    pub first_line: usize,
}

impl FixPreview {
    /// The window two versions of one file differ over, or `None` when they match.
    #[must_use]
    pub fn between(title: String, before: &str, after: &str) -> Option<Self> {
        let diff = TextDiff::from_lines(before, after);
        let mut changed = diff.ops().iter().filter(|op| op.tag() != DiffTag::Equal);

        let first = changed.next()?;
        let last = changed.next_back().unwrap_or(first);
        let old = first.old_range().start..last.old_range().end;
        let new = first.new_range().start..last.new_range().end;

        Some(Self {
            title,
            before: diff.old_slices().get(old.clone())?.concat(),
            after: diff.new_slices().get(new)?.concat(),
            first_line: old.start + 1,
        })
    }
}

/// Whether the run applied the fix or only offers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Badge {
    Fixable,
    Fixed,
}

impl Badge {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Fixable => "FIXABLE",
            Self::Fixed => "FIXED",
        }
    }
}

/// One reported problem, with everything the reporters print for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub path: PathBuf,
    /// Absent for a whole-file diagnostic, which prints no `line:col`.
    pub span: Option<Span>,
    pub rule: RuleId,
    pub level: Level,
    pub message: String,
    pub advice: Vec<String>,
    pub fix: Option<FixPreview>,
    pub badge: Option<Badge>,
}

impl Diagnostic {
    pub fn new(path: impl Into<PathBuf>, rule: RuleId, level: Level, message: String) -> Self {
        Self {
            path: path.into(),
            span: None,
            rule,
            level,
            message,
            advice: Vec::new(),
            fix: None,
            badge: None,
        }
    }

    #[must_use]
    pub const fn at(mut self, span: Span) -> Self {
        self.span = Some(span);
        self
    }

    #[must_use]
    pub fn advise(mut self, advice: impl Into<String>) -> Self {
        self.advice.push(advice.into());
        self
    }

    /// Attaches the preview and the badge that names its state.
    #[must_use]
    pub fn fixed_by(mut self, preview: Option<FixPreview>, badge: Badge) -> Self {
        if preview.is_some() {
            self.badge = Some(badge);
        }
        self.fix = preview;
        self
    }

    /// Sorts by file, then position, then rule, so output is stable across runs.
    #[must_use]
    pub fn sort_key(&self) -> (&Path, Position, RuleId) {
        (
            self.path.as_path(),
            self.span
                .map_or_else(Position::file_start, |span| span.start),
            self.rule,
        )
    }
}

/// The rule name in a header, a concise line and a GitHub `title`.
///
/// Doc rules are namespaced the way Biome namespaces its lint rules; the passes that are
/// not doc rules keep their bare name.
#[must_use]
pub fn display_name(rule: RuleId) -> String {
    match rule {
        RuleId::PARSE | RuleId::FORMAT | RuleId::FILL => rule.as_str().to_owned(),
        _ => format!("lint/{rule}"),
    }
}

/// Capitalises the first letter.
#[must_use]
pub fn capitalise(body: &str) -> String {
    let mut characters = body.chars();
    match characters.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), characters.as_str()),
        None => String::new(),
    }
}

/// Capitalises the first letter and closes the sentence with a period.
#[must_use]
pub fn sentence(body: &str) -> String {
    let opened = capitalise(body);
    if opened.ends_with('.') {
        opened
    } else {
        format!("{opened}.")
    }
}

/// How many diagnostics are at error and at warning level.
#[must_use]
pub fn counts(diagnostics: &[Diagnostic]) -> (usize, usize) {
    let errors = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.level == Level::Error)
        .count();
    let warnings = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.level == Level::Warn)
        .count();
    (errors, warnings)
}

/// Which reporter renders a run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum Reporter {
    /// Header, code frame, advice and fix diff.
    #[default]
    Default,
    /// One line per diagnostic.
    Concise,
    /// GitHub workflow commands.
    Github,
}

/// Everything the output flags resolve to.
#[derive(Clone, Copy, Debug)]
pub struct Output {
    pub reporter: Reporter,
    /// Lowest level shown; diagnostics below it still count in the summary.
    pub level: Level,
    /// Cap on shown diagnostics; `None` lifts it.
    pub max: Option<usize>,
    pub colors: bool,
}

impl Default for Output {
    fn default() -> Self {
        Self {
            reporter: Reporter::default(),
            level: Level::Info,
            max: Some(20),
            colors: false,
        }
    }
}

impl Output {
    /// Writes every shown diagnostic and returns how many the cap hid.
    /// # Errors
    /// Returns an error when the writer fails.
    pub fn render(
        &self,
        out: &mut impl Write,
        diagnostics: &[Diagnostic],
    ) -> std::io::Result<usize> {
        let mut sources = Sources::default();
        let mut shown = 0;
        let mut hidden = 0;

        for diagnostic in diagnostics {
            if diagnostic.level < self.level || diagnostic.level == Level::Off {
                continue;
            }
            if self.max.is_some_and(|max| shown >= max) {
                hidden += 1;
                continue;
            }
            shown += 1;

            match self.reporter {
                Reporter::Default => {
                    out.write_all(default_block(diagnostic, &mut sources, self.colors).as_bytes())?;
                }
                Reporter::Concise => {
                    out.write_all(concise_line(diagnostic, self.colors).as_bytes())?;
                }
                Reporter::Github => out.write_all(github_line(diagnostic).as_bytes())?,
            }
        }

        out.flush()?;
        Ok(hidden)
    }
}

/// The two-line notice printed when the cap hid diagnostics.
#[must_use]
pub fn truncation(hidden: usize) -> String {
    format!("{TRUNCATION_NOTICE}\nDiagnostics not shown: {hidden}.")
}

/// What a run did to the files it read, as the summary phrases it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// `check`, and `fix --dry-run`.
    NoFixes,
    /// Files rewritten by `fix`.
    Fixed(usize),
    /// Values written by `fill-constraints`, and the files that took them.
    Filled { values: usize, files: usize },
}

/// The stderr summary, built from a measured duration so tests can pin it.
#[derive(Clone, Copy, Debug)]
pub struct Summary {
    pub files: usize,
    pub duration: Duration,
    pub action: Action,
    pub errors: usize,
    pub warnings: usize,
}

impl Summary {
    #[must_use]
    pub fn render(&self) -> String {
        let action = match self.action {
            Action::NoFixes => " No fixes applied.".to_owned(),
            Action::Fixed(files) => format!(" Fixed {}.", plural(files, "file")),
            Action::Filled { values, files } => format!(
                " Filled {} in {}.",
                plural(values, "value"),
                plural(files, "file")
            ),
        };

        let mut out = format!(
            "Checked {} in {}.{action}",
            plural(self.files, "file"),
            duration(self.duration)
        );
        if self.errors > 0 {
            let _ = write!(out, "\nFound {}.", plural(self.errors, "error"));
        }
        if self.warnings > 0 {
            let _ = write!(out, "\nFound {}.", plural(self.warnings, "warning"));
        }
        out
    }
}

fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        format!("{count} {word}")
    } else {
        format!("{count} {word}s")
    }
}

/// Sub-millisecond runs keep their microseconds; a run over a second reads in seconds.
fn duration(elapsed: Duration) -> String {
    let micros = elapsed.as_micros();
    if micros < 1_000 {
        format!("{micros}\u{b5}s")
    } else if micros < 1_000_000 {
        format!("{}ms", micros / 1_000)
    } else {
        format!("{:.1}s", elapsed.as_secs_f64())
    }
}

/// File texts read for code frames, read once per file.
#[derive(Default)]
struct Sources {
    texts: BTreeMap<PathBuf, Option<String>>,
}

impl Sources {
    fn get(&mut self, path: &Path) -> Option<&str> {
        self.texts
            .entry(path.to_owned())
            .or_insert_with(|| std::fs::read_to_string(path).ok())
            .as_deref()
    }
}

fn paint(text: &str, style: Style, colors: bool) -> String {
    if colors {
        format!("{}{text}{}", style.render(), style.render_reset())
    } else {
        text.to_owned()
    }
}

const fn level_style(level: Level) -> Style {
    Style::new().fg_color(Some(Color::Ansi(level.color())))
}

fn header(diagnostic: &Diagnostic, colors: bool) -> String {
    let location = match diagnostic.span {
        Some(span) => format!(
            "{}:{}:{}",
            diagnostic.path.display(),
            span.start.line,
            span.start.column
        ),
        None => diagnostic.path.display().to_string(),
    };
    let name = display_name(diagnostic.rule);

    let plain = match diagnostic.badge {
        Some(badge) => format!("{location} {name}  {}  ", badge.as_str()),
        None => format!("{location} {name} "),
    };
    let glyphs = HEADER_WIDTH
        .saturating_sub(plain.chars().count())
        .max(MIN_RULE_GLYPHS);

    let painted = paint(&location, Style::new().bold(), colors);
    format!(
        "{}{}{}\n",
        painted,
        &plain[location.len()..],
        "\u{2501}".repeat(glyphs)
    )
}

/// Header, message, code frame, advice, fix diff; one blank line between blocks.
fn default_block(diagnostic: &Diagnostic, sources: &mut Sources, colors: bool) -> String {
    let style = level_style(diagnostic.level);
    let mut out = header(diagnostic, colors);

    let glyph = paint(&diagnostic.level.glyph().to_string(), style.bold(), colors);
    let _ = write!(out, "\n{INDENT}{glyph} {}\n", diagnostic.message);

    // An applied fix already rewrote the file, so the diff below stands in for the frame.
    if diagnostic.badge != Some(Badge::Fixed)
        && let Some(span) = diagnostic.span
        && let Some(source) = sources.get(&diagnostic.path)
        && let Some(frame) = frame(source, span, style, colors)
    {
        let _ = write!(out, "\n{frame}");
    }

    let info = paint("i", level_style(Level::Info).bold(), colors);
    for advice in &diagnostic.advice {
        let _ = write!(out, "\n{INDENT}{info} {advice}\n");
    }

    if let Some(preview) = &diagnostic.fix {
        let _ = write!(out, "\n{INDENT}{info} {}\n", preview.title);
        let _ = write!(out, "\n{}", diff(preview, colors));
    }

    out.push('\n');
    out
}

/// The finding line with up to [`CONTEXT`] lines on each side, and the underline.
fn frame(source: &str, span: Span, style: Style, colors: bool) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();
    let index = span.start.line.checked_sub(1)?;
    if index >= lines.len() {
        return None;
    }

    let from = index.saturating_sub(CONTEXT);
    let to = (index + CONTEXT).min(lines.len() - 1);
    let width = (to + 1).to_string().len();

    let mut out = String::new();
    for (number, text) in (from..=to).map(|line| (line + 1, lines[line])) {
        let marker = if number == span.start.line {
            "> "
        } else {
            "  "
        };
        let _ = writeln!(out, "{INDENT}{marker}{number:>width$} \u{2502} {text}");
        if number == span.start.line {
            let _ = writeln!(
                out,
                "{INDENT}  {:width$} \u{2502} {}",
                "",
                underline(text, span, style, colors)
            );
        }
    }
    Some(out)
}

/// Carets under the span, padded to its start; a multi-line span stops at the line end.
fn underline(text: &str, span: Span, style: Style, colors: bool) -> String {
    let start = boundary(text, span.start.column.saturating_sub(1));
    let end = if span.end.line == span.start.line {
        boundary(text, span.end.column.saturating_sub(1)).max(start)
    } else {
        text.len()
    };

    let pad = text[..start].chars().count();
    let carets = text[start..end].chars().count().max(1);
    format!(
        "{}{}",
        " ".repeat(pad),
        paint(&"^".repeat(carets), style.bold(), colors)
    )
}

/// The nearest char boundary at or below `byte`, clamped to the line.
fn boundary(text: &str, byte: usize) -> usize {
    let mut at = byte.min(text.len());
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The preview's window as a two-column line diff, spaces shown as `·` on changed lines.
fn diff(preview: &FixPreview, colors: bool) -> String {
    let text = TextDiff::from_lines(&preview.before, &preview.after);

    let mut rows: Vec<(Option<usize>, Option<usize>, &'static str, String)> = Vec::new();
    let mut old = preview.first_line;
    let mut new = preview.first_line;

    for change in text.iter_all_changes() {
        let value = change.value().trim_end_matches(['\n', '\r']);
        match change.tag() {
            ChangeTag::Delete => {
                rows.push((Some(old), None, "- ", value.replace(' ', "\u{b7}")));
                old += 1;
            }
            ChangeTag::Insert => {
                rows.push((None, Some(new), "+ ", value.replace(' ', "\u{b7}")));
                new += 1;
            }
            ChangeTag::Equal => {
                rows.push((Some(old), Some(new), "  ", value.to_owned()));
                old += 1;
                new += 1;
            }
        }
    }

    let old_width = column_width(rows.iter().filter_map(|row| row.0));
    let new_width = column_width(rows.iter().filter_map(|row| row.1));

    let mut out = String::new();
    for (old, new, marker, text) in rows {
        let style = match marker {
            "- " => level_style(Level::Error),
            "+ " => Style::new().fg_color(Some(Color::Ansi(AnsiColor::Green))),
            _ => Style::new(),
        };
        let body = paint(&format!("{marker}{text}"), style, colors);
        let _ = writeln!(
            out,
            "{INDENT}  {:>old_width$} {:>new_width$} \u{2502} {body}",
            old.map_or_else(String::new, |line| line.to_string()),
            new.map_or_else(String::new, |line| line.to_string()),
        );
    }
    out
}

fn column_width(numbers: impl Iterator<Item = usize>) -> usize {
    numbers
        .map(|number| number.to_string().len())
        .max()
        .unwrap_or(1)
}

fn concise_line(diagnostic: &Diagnostic, colors: bool) -> String {
    let location = match diagnostic.span {
        Some(span) => format!(
            "{}:{}:{}",
            diagnostic.path.display(),
            span.start.line,
            span.start.column
        ),
        None => diagnostic.path.display().to_string(),
    };
    let glyph = paint(
        &diagnostic.level.glyph().to_string(),
        level_style(diagnostic.level).bold(),
        colors,
    );

    format!(
        "{glyph} {location}: {}: {}\n",
        display_name(diagnostic.rule),
        diagnostic.message
    )
}

fn github_line(diagnostic: &Diagnostic) -> String {
    let position = match diagnostic.span {
        Some(span) => format!(
            ",line={},endLine={},col={},endColumn={}",
            span.start.line, span.end.line, span.start.column, span.end.column
        ),
        None => String::new(),
    };

    format!(
        "::{} title={},file={}{position}::{}\n",
        diagnostic.level.github(),
        github_property(&display_name(diagnostic.rule)),
        github_property(&diagnostic.path.display().to_string()),
        github_message(&diagnostic.message)
    )
}

/// A workflow command ends at a newline, so the message carries none; `%` opens an
/// escape, so it escapes itself.
fn github_message(text: &str) -> String {
    text.replace('%', "%25")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// A property value also ends at the comma or colon that opens the next field.
fn github_property(text: &str) -> String {
    github_message(text).replace(',', "%2C").replace(':', "%3A")
}

#[cfg(test)]
mod tests {
    use super::{
        Action, Badge, Diagnostic, FixPreview, Level, Output, Position, Reporter, Span, Summary,
        diff, duration, frame, header, level_style,
    };
    use crate::report::RuleId;
    use std::time::Duration;

    fn at(line: usize, column: usize) -> Position {
        Position { line, column }
    }

    fn diagnostic() -> Diagnostic {
        Diagnostic::new(
            "Gaps.compact",
            RuleId::MISSING_DOC,
            Level::Error,
            "Ledger `_owner` has no doc comment.".to_owned(),
        )
        .at(Span::columns(at(6, 3), 20))
    }

    #[test]
    fn a_frame_underlines_the_span_at_its_column() {
        let source = "one\ntwo\nthree four\nfive\nsix\n";
        let rendered = frame(
            source,
            Span::columns(at(3, 7), 4),
            level_style(Level::Error),
            false,
        )
        .expect("the line is in the source");

        assert_eq!(
            rendered,
            concat!(
                "    1 \u{2502} one\n",
                "    2 \u{2502} two\n",
                "  > 3 \u{2502} three four\n",
                "      \u{2502}       ^^^^\n",
                "    4 \u{2502} five\n",
                "    5 \u{2502} six\n",
            )
        );
    }

    #[test]
    fn a_span_past_the_line_end_underlines_one_column() {
        let rendered = frame(
            "short\n",
            Span::columns(at(1, 40), 3),
            level_style(Level::Error),
            false,
        )
        .expect("the line is in the source");

        assert!(rendered.ends_with("\u{2502}      ^\n"), "{rendered}");
    }

    #[test]
    fn a_header_fills_to_one_hundred_columns() {
        let rendered = header(&diagnostic(), false);

        assert_eq!(rendered.chars().count(), 101, "{rendered}");
        assert!(rendered.starts_with("Gaps.compact:6:3 lint/missing-doc \u{2501}"));
    }

    #[test]
    fn a_long_header_keeps_ten_rule_glyphs() {
        let long = "a".repeat(140);
        let rendered = header(
            &Diagnostic::new(long, RuleId::FORMAT, Level::Error, String::new()),
            false,
        );

        assert!(rendered.ends_with(&format!("format {}\n", "\u{2501}".repeat(10))));
    }

    #[test]
    fn a_badge_sits_between_the_rule_and_the_glyphs() {
        let rendered = header(
            &diagnostic().fixed_by(
                Some(FixPreview {
                    title: "Unsafe fix: Insert a doc skeleton".to_owned(),
                    before: String::new(),
                    after: String::new(),
                    first_line: 1,
                }),
                Badge::Fixable,
            ),
            false,
        );

        assert!(
            rendered.contains("lint/missing-doc  FIXABLE  \u{2501}"),
            "{rendered}"
        );
    }

    #[test]
    fn a_diff_marks_changed_lines_and_shows_their_spaces() {
        let preview = FixPreview::between(
            "Unsafe fix: Rename @return to @returns".to_owned(),
            "/**\n * @return x\n */\n",
            "/**\n * @returns x\n */\n",
        )
        .expect("the texts differ");

        assert_eq!(preview.first_line, 2);
        assert_eq!(
            diff(&preview, false),
            concat!(
                "    2   \u{2502} - \u{b7}*\u{b7}@return\u{b7}x\n",
                "      2 \u{2502} + \u{b7}*\u{b7}@returns\u{b7}x\n",
            )
        );
    }

    #[test]
    fn an_insertion_numbers_only_the_new_side() {
        let preview = FixPreview::between(
            "Unsafe fix: Insert @description".to_owned(),
            "a\nb\n",
            "a\nnew\nb\n",
        )
        .expect("the texts differ");

        assert_eq!(preview.first_line, 2);
        assert_eq!(diff(&preview, false), "      2 \u{2502} + new\n");
    }

    #[test]
    fn identical_texts_have_no_preview() {
        assert!(FixPreview::between(String::new(), "a\n", "a\n").is_none());
    }

    #[test]
    fn colors_wrap_the_glyph_and_stay_out_of_the_plain_render() {
        let mut painted = Vec::new();
        Output {
            colors: true,
            ..Output::default()
        }
        .render(&mut painted, std::slice::from_ref(&diagnostic()))
        .expect("the writer accepts the render");

        let mut plain = Vec::new();
        Output::default()
            .render(&mut plain, std::slice::from_ref(&diagnostic()))
            .expect("the writer accepts the render");

        assert!(String::from_utf8_lossy(&painted).contains('\u{1b}'));
        assert!(!String::from_utf8_lossy(&plain).contains('\u{1b}'));
    }

    #[test]
    fn the_cap_counts_what_it_hides() {
        let diagnostics = [diagnostic(), diagnostic(), diagnostic()];
        let mut out = Vec::new();

        let hidden = Output {
            max: Some(1),
            ..Output::default()
        }
        .render(&mut out, &diagnostics)
        .expect("the writer accepts the render");

        assert_eq!(hidden, 2);
    }

    #[test]
    fn the_level_filter_hides_the_quieter_diagnostics() {
        let warning = Diagnostic::new(
            "a.compact",
            RuleId::CONSTRAINTS_PLACEHOLDER,
            Level::Warn,
            "A warning.".to_owned(),
        );
        let mut out = Vec::new();

        Output {
            level: Level::Error,
            reporter: Reporter::Concise,
            ..Output::default()
        }
        .render(&mut out, &[warning])
        .expect("the writer accepts the render");

        assert!(out.is_empty(), "{}", String::from_utf8_lossy(&out));
    }

    #[test]
    fn the_concise_and_github_reporters_render_one_line_each() {
        let mut concise = Vec::new();
        Output {
            reporter: Reporter::Concise,
            ..Output::default()
        }
        .render(&mut concise, std::slice::from_ref(&diagnostic()))
        .expect("the writer accepts the render");

        let mut github = Vec::new();
        Output {
            reporter: Reporter::Github,
            ..Output::default()
        }
        .render(&mut github, std::slice::from_ref(&diagnostic()))
        .expect("the writer accepts the render");

        assert_eq!(
            String::from_utf8_lossy(&concise),
            "\u{d7} Gaps.compact:6:3: lint/missing-doc: Ledger `_owner` has no doc comment.\n"
        );
        assert_eq!(
            String::from_utf8_lossy(&github),
            "::error title=lint/missing-doc,file=Gaps.compact,line=6,endLine=6,col=3,endColumn=23::Ledger `_owner` has no doc comment.\n"
        );
    }

    #[test]
    fn the_github_reporter_escapes_what_would_end_a_field() {
        let awkward = Diagnostic::new(
            "src/a,b/Token.compact",
            RuleId::CONSTRAINTS_FORMAT,
            Level::Error,
            "@constraints value `k=10%` is not `k=<n>, rows=<n>`.".to_owned(),
        )
        .at(Span::columns(at(3, 6), 12));

        assert_eq!(
            super::github_line(&awkward),
            "::error title=lint/constraints-format,file=src/a%2Cb/Token.compact,line=3,endLine=3,col=6,endColumn=18::@constraints value `k=10%25` is not `k=<n>, rows=<n>`.\n"
        );
    }

    #[test]
    fn a_whole_file_diagnostic_prints_no_line_or_column() {
        let whole = Diagnostic::new(
            "a.compact",
            RuleId::FORMAT,
            Level::Error,
            "Not formatted.".to_owned(),
        );

        assert!(super::concise_line(&whole, false).starts_with("\u{d7} a.compact: format: "));
        assert_eq!(
            super::github_line(&whole),
            "::error title=format,file=a.compact::Not formatted.\n"
        );
    }

    #[test]
    fn the_summary_counts_singulars_and_plurals_apart() {
        let summary = Summary {
            files: 1,
            duration: Duration::from_millis(5),
            action: Action::NoFixes,
            errors: 1,
            warnings: 2,
        };

        assert_eq!(
            summary.render(),
            "Checked 1 file in 5ms. No fixes applied.\nFound 1 error.\nFound 2 warnings."
        );
    }

    #[test]
    fn a_clean_summary_names_neither_errors_nor_warnings() {
        let summary = Summary {
            files: 3,
            duration: Duration::from_millis(4),
            action: Action::Filled {
                values: 1,
                files: 1,
            },
            errors: 0,
            warnings: 0,
        };

        assert_eq!(
            summary.render(),
            "Checked 3 files in 4ms. Filled 1 value in 1 file."
        );
    }

    #[test]
    fn durations_read_in_the_unit_that_fits() {
        assert_eq!(duration(Duration::from_micros(400)), "400\u{b5}s");
        assert_eq!(duration(Duration::from_millis(5)), "5ms");
        assert_eq!(duration(Duration::from_millis(1234)), "1.2s");
    }
}
