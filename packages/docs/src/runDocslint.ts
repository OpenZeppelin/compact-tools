#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import chalk from "chalk";
import { CircuitParser } from "./CircuitParser.js";
import { DEFAULT_OPTIONS, DocValidator } from "./DocValidator.js";
import type { ValidatorOptions } from "./DocValidator.js";
import { FileDiscovery } from "./FileDiscovery.js";
import type { FileSummary, ValidationResult } from "./types.js";

/**
 * Determines if a path is a directory
 */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Parses command line arguments
 */
function parseArgs(args: string[]): {
	target: string;
	options: Partial<ValidatorOptions>;
	showHelp: boolean;
} {
	const options: Partial<ValidatorOptions> = {};
	let target = ".";
	let showHelp = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case "--help":
			case "-h":
				showHelp = true;
				break;
			case "--all":
			case "-a":
				options.exportedOnly = false;
				break;
			case "--require-title":
				options.requireTitle = true;
				break;
			case "--require-remarks":
				options.requireRemarks = true;
				break;
			case "--require-throws":
				options.requireThrows = true;
				break;
			case "--no-require-description":
				options.requireDescription = false;
				break;
			case "--no-require-circuit-info":
				options.requireCircuitInfo = false;
				break;
			case "--no-require-params":
				options.requireParams = false;
				break;
			case "--no-require-returns":
				options.requireReturns = false;
				break;
			case "--strict":
				options.requireTitle = true;
				options.requireRemarks = true;
				options.requireThrows = true;
				break;
			default:
				if (!arg.startsWith("-")) {
					target = arg;
				}
		}
	}

	return { target, options, showHelp };
}

/**
 * Formats a validation result for console output
 */
function formatResult(
	result: ValidationResult,
	workingDir: string,
): string[] {
	const lines: string[] = [];
	const relativePath = relative(workingDir, result.filePath);

	for (const issue of result.issues) {
		const location = `${relativePath}:${issue.line}`;
		const severity =
			issue.severity === "error"
				? chalk.red("error")
				: chalk.yellow("warning");
		const field = chalk.dim(`[${issue.field}]`);
		const circuit = chalk.cyan(result.circuitName);

		lines.push(
			`  ${location} ${severity} ${field} ${circuit}: ${issue.message}`,
		);
	}

	return lines;
}

/**
 * Prints the summary of all validations
 */
function printSummary(summaries: FileSummary[]): void {
	const totalFiles = summaries.length;
	const totalCircuits = summaries.reduce((sum, s) => sum + s.totalCircuits, 0);
	const totalWarnings = summaries.reduce((sum, s) => sum + s.totalWarnings, 0);
	const totalErrors = summaries.reduce((sum, s) => sum + s.totalErrors, 0);
	const validCircuits = summaries.reduce((sum, s) => sum + s.validCircuits, 0);

	console.log("");
	console.log(chalk.bold("Summary:"));
	console.log(
		`  Files checked: ${totalFiles}, Circuits: ${totalCircuits}, Valid: ${validCircuits}`,
	);

	if (totalWarnings > 0 || totalErrors > 0) {
		const warningText =
			totalWarnings > 0 ? chalk.yellow(`${totalWarnings} warning(s)`) : "";
		const errorText =
			totalErrors > 0 ? chalk.red(`${totalErrors} error(s)`) : "";
		const separator = totalWarnings > 0 && totalErrors > 0 ? ", " : "";
		console.log(`  Issues: ${warningText}${separator}${errorText}`);
	}
}

/**
 * Shows usage help
 */
function showUsageHelp(): void {
	console.log(chalk.bold("\nUsage:") + " compact-docslint [options] [target]");

	console.log(chalk.bold("\nArguments:"));
	console.log(
		"  [target]                    Path to .compact file or directory (default: .)",
	);

	console.log(chalk.bold("\nOptions:"));
	console.log("  -h, --help                  Show this help message");
	console.log("  -a, --all                   Check all circuits (not just exported)");
	console.log("  --strict                    Enable all strict checks");

	console.log(chalk.bold("\nStrict options:"));
	console.log("  --require-title             Require @title tag");
	console.log("  --require-remarks           Require @remarks section");
	console.log("  --require-throws            Require @throws documentation");

	console.log(chalk.bold("\nRelaxed options:"));
	console.log("  --no-require-description    Don't require @description");
	console.log("  --no-require-circuit-info   Don't require @circuitInfo");
	console.log("  --no-require-params         Don't require @param for parameters");
	console.log("  --no-require-returns        Don't require @returns");

	console.log(chalk.bold("\nDefault requirements:"));
	console.log("  - @description");
	console.log("  - @circuitInfo (format: k=<number>, rows=<number>)");
	console.log("  - @param for each circuit parameter");
	console.log("  - @returns");

	console.log(chalk.bold("\nExamples:"));
	console.log("  compact-docslint                        # Check all .compact files in current directory");
	console.log("  compact-docslint src                    # Check all .compact files in src/");
	console.log("  compact-docslint src/Counter.compact    # Check a single file");
	console.log("  compact-docslint --strict src           # Enable all strict checks");
	console.log("  compact-docslint -a src                 # Check all circuits (including non-exported)");

	console.log(chalk.bold("\nExpected documentation template:"));
	console.log(chalk.dim(`
  /**
   * @title Foo circuit
   * @description Reverts unless the caller is the contract admin.
   *
   * @remarks
   * Requirements:
   * - \`caller\` must equal \`admin\`, otherwise the circuit aborts.
   *
   * @circuitInfo k=11, rows=1305
   *
   * @param {Type} paramName - Description of the parameter.
   *
   * @throws {Error} "error message" if condition.
   *
   * @returns {Type} - Description of return value.
   */
`));
}

/**
 * Main CLI entry point
 */
async function runDocslint(): Promise<void> {
	const workingDir = process.cwd();

	try {
		const args = process.argv.slice(2);
		const { target, options, showHelp: helpRequested } = parseArgs(args);

		if (helpRequested) {
			showUsageHelp();
			return;
		}

		const resolvedTarget = resolve(target);

		console.log(
			chalk.blue("compact-docslint") +
				chalk.dim(" - Documentation linter for Compact contracts"),
		);
		console.log("");

		if (!existsSync(resolvedTarget)) {
			console.error(chalk.red(`Error: Path not found: ${resolvedTarget}`));
			process.exit(1);
		}

		const discovery = new FileDiscovery();
		let files: string[] = [];

		if (isDirectory(resolvedTarget)) {
			console.log(chalk.dim(`Scanning ${relative(workingDir, resolvedTarget) || "."} for .compact files...`));
			files = await discovery.getCompactFiles(resolvedTarget);

			if (files.length === 0) {
				console.log(
					chalk.yellow(`No .compact files found in ${resolvedTarget}`),
				);
				return;
			}

			console.log(chalk.dim(`Found ${files.length} .compact file(s)`));
			console.log("");
		} else {
			if (!resolvedTarget.endsWith(".compact")) {
				console.error(
					chalk.red(`Error: File must have .compact extension: ${resolvedTarget}`),
				);
				process.exit(1);
			}
			files = [resolvedTarget];
		}

		// Merge options with defaults
		const validatorOptions: ValidatorOptions = { ...DEFAULT_OPTIONS, ...options };

		const parser = new CircuitParser();
		const validator = new DocValidator(validatorOptions);
		const allSummaries: FileSummary[] = [];
		let hasIssues = false;

		for (const file of files) {
			const circuits = parser.parseFile(file);
			const validations = validator.validateAll(circuits, file);
			const summary = validator.summarize(validations, file);
			allSummaries.push(summary);

			// Output issues for this file
			for (const result of validations) {
				if (!result.isValid) {
					hasIssues = true;
					const formatted = formatResult(result, workingDir);
					for (const line of formatted) {
						console.log(line);
					}
				}
			}
		}

		printSummary(allSummaries);

		if (hasIssues) {
			process.exit(1);
		} else {
			console.log(
				chalk.green("\n✓ All circuits have valid documentation"),
			);
		}
	} catch (error) {
		console.error(
			chalk.red(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		process.exit(1);
	}
}

runDocslint();

