import type {
	CircuitDoc,
	FileSummary,
	ValidationIssue,
	ValidationResult,
} from "./types.js";

/**
 * Configuration options for the validator
 */
export interface ValidatorOptions {
	/** Whether to only check exported circuits (default: true) */
	exportedOnly: boolean;
	/** Whether @title is required (default: false) */
	requireTitle: boolean;
	/** Whether @description is required (default: true) */
	requireDescription: boolean;
	/** Whether @remarks is required (default: false) */
	requireRemarks: boolean;
	/** Whether @circuitInfo is required (default: true) */
	requireCircuitInfo: boolean;
	/** Whether @param for each parameter is required (default: true) */
	requireParams: boolean;
	/** Whether @throws is required when circuit has assert (default: false) */
	requireThrows: boolean;
	/** Whether @returns is required (default: true) */
	requireReturns: boolean;
}

/**
 * Default validator options
 */
export const DEFAULT_OPTIONS: ValidatorOptions = {
	exportedOnly: true,
	requireTitle: false,
	requireDescription: true,
	requireRemarks: false,
	requireCircuitInfo: true,
	requireParams: true,
	requireThrows: false,
	requireReturns: true,
};

/**
 * Validator for checking documentation format against the template.
 * Validates circuits against required JSDoc-style documentation tags.
 *
 * Expected template:
 * ```
 * /**
 *  * @title Foo circuit
 *  * @description Reverts unless the caller is the contract admin.
 *  *
 *  * @remarks
 *  * Requirements:
 *  * - `caller` must equal `admin`, otherwise the circuit aborts with "not admin".
 *  *
 *  * @circuitInfo k=11, rows=1305
 *  *
 *  * @param {Either<ZswapCoinPublicKey, ContractAddress>} admin  - The admin account.
 *  * @param {Either<ZswapCoinPublicKey, ContractAddress>} caller - The entity invoking.
 *  *
 *  * @throws {Error} "not admin" if the provided caller does not match the admin.
 *  *
 *  * @returns [] - No return values.
 *  * /
 * ```
 */
export class DocValidator {
	private options: ValidatorOptions;

	constructor(options: Partial<ValidatorOptions> = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Validates a circuit's documentation against the required template
	 */
	validate(circuit: CircuitDoc, filePath: string): ValidationResult {
		const issues: ValidationIssue[] = [];

		// Skip non-exported circuits if option is set
		if (this.options.exportedOnly && !circuit.isExported) {
			return {
				circuitName: circuit.name,
				filePath,
				line: circuit.circuitLine,
				isValid: true,
				issues: [],
			};
		}

		// Check if circuit has documentation at all
		if (!circuit.hasDocs) {
			issues.push({
				message: "Circuit has no documentation comment",
				severity: "warning",
				line: circuit.circuitLine,
				field: "documentation",
			});

			return {
				circuitName: circuit.name,
				filePath,
				line: circuit.circuitLine,
				isValid: false,
				issues,
			};
		}

		// Check @title
		if (this.options.requireTitle && !circuit.parsed.title) {
			issues.push({
				message: "Missing @title tag",
				severity: "warning",
				line: circuit.docStartLine,
				field: "@title",
			});
		}

		// Check @description
		if (this.options.requireDescription && !circuit.parsed.description) {
			issues.push({
				message: "Missing @description tag",
				severity: "warning",
				line: circuit.docStartLine,
				field: "@description",
			});
		}

		// Check @remarks
		if (this.options.requireRemarks && !circuit.parsed.remarks) {
			issues.push({
				message: "Missing @remarks section",
				severity: "warning",
				line: circuit.docStartLine,
				field: "@remarks",
			});
		}

		// Check @circuitInfo
		if (this.options.requireCircuitInfo) {
			if (!circuit.parsed.circuitInfo) {
				issues.push({
					message: "Missing @circuitInfo tag",
					severity: "warning",
					line: circuit.docStartLine,
					field: "@circuitInfo",
				});
			} else {
				// Validate @circuitInfo format: should be "k=number, rows=number"
				const circuitInfoMatch = circuit.parsed.circuitInfo
					.trim()
					.match(/^k\s*=\s*(\d+)\s*,\s*rows\s*=\s*(\d+)$/);
				if (!circuitInfoMatch) {
					issues.push({
						message: `Invalid @circuitInfo format: "${circuit.parsed.circuitInfo}". Expected: k=<number>, rows=<number>`,
						severity: "warning",
						line: circuit.docStartLine,
						field: "@circuitInfo",
					});
				}
			}
		}

		// Check @param for each parameter
		if (this.options.requireParams && circuit.signatureParams.length > 0) {
			const documentedParams = new Set(
				circuit.parsed.params.map((p) => p.name),
			);

			for (const param of circuit.signatureParams) {
				if (!documentedParams.has(param.name)) {
					issues.push({
						message: `Missing @param documentation for parameter "${param.name}" (type: ${param.type})`,
						severity: "warning",
						line: circuit.docStartLine,
						field: "@param",
					});
				}
			}

			// Check for extra documented params that don't exist in signature
			const signatureParamNames = new Set(
				circuit.signatureParams.map((p) => p.name),
			);
			for (const docParam of circuit.parsed.params) {
				if (!signatureParamNames.has(docParam.name)) {
					issues.push({
						message: `Documented @param "${docParam.name}" does not exist in circuit signature`,
						severity: "warning",
						line: circuit.docStartLine,
						field: "@param",
					});
				}
			}
		}

		// Check @throws (optional)
		if (this.options.requireThrows && circuit.parsed.throws.length === 0) {
			issues.push({
				message: "Missing @throws documentation",
				severity: "warning",
				line: circuit.docStartLine,
				field: "@throws",
			});
		}

		// Check @returns
		if (this.options.requireReturns && !circuit.parsed.returns) {
			issues.push({
				message: "Missing @returns tag",
				severity: "warning",
				line: circuit.docStartLine,
				field: "@returns",
			});
		}

		return {
			circuitName: circuit.name,
			filePath,
			line: circuit.circuitLine,
			isValid: issues.length === 0,
			issues,
		};
	}

	/**
	 * Validates multiple circuits
	 */
	validateAll(circuits: CircuitDoc[], filePath: string): ValidationResult[] {
		return circuits.map((circuit) => this.validate(circuit, filePath));
	}

	/**
	 * Generates a summary for validation results of a file
	 */
	summarize(results: ValidationResult[], filePath: string): FileSummary {
		let totalWarnings = 0;
		let totalErrors = 0;
		let validCircuits = 0;
		let circuitsWithIssues = 0;

		for (const result of results) {
			if (result.isValid) {
				validCircuits++;
			} else {
				circuitsWithIssues++;
			}

			for (const issue of result.issues) {
				if (issue.severity === "warning") {
					totalWarnings++;
				} else {
					totalErrors++;
				}
			}
		}

		return {
			filePath,
			totalCircuits: results.length,
			validCircuits,
			circuitsWithIssues,
			totalWarnings,
			totalErrors,
		};
	}
}

