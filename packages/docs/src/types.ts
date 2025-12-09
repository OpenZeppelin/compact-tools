/**
 * Represents a parameter parsed from a circuit signature
 */
export interface CircuitParam {
	/** Parameter name */
	name: string;
	/** Parameter type */
	type: string;
}

/**
 * Represents a parameter from documentation
 */
export interface DocParam {
	/** Parameter name */
	name: string;
	/** Parameter type from docs */
	type: string;
	/** Parameter description */
	description: string;
}

/**
 * Represents a throws/error from documentation
 */
export interface DocThrows {
	/** Error type */
	type: string;
	/** Error message/condition */
	message: string;
}

/**
 * Represents the parsed documentation comment
 */
export interface ParsedDoc {
	/** @title - Circuit title */
	title?: string;
	/** @description - Circuit description */
	description?: string;
	/** @remarks - Additional remarks */
	remarks?: string;
	/** @circuitInfo - Circuit metadata (k, rows) */
	circuitInfo?: string;
	/** @param entries */
	params: DocParam[];
	/** @throws entries */
	throws: DocThrows[];
	/** @returns - Return type and description */
	returns?: {
		type: string;
		description: string;
	};
}

/**
 * Represents a parsed circuit with its documentation and signature
 */
export interface CircuitDoc {
	/** Circuit name */
	name: string;
	/** Full documentation comment block */
	docComment: string;
	/** Line number of the circuit declaration */
	circuitLine: number;
	/** Start line of the documentation comment */
	docStartLine: number;
	/** End line of the documentation comment */
	docEndLine: number;
	/** Whether the circuit has documentation */
	hasDocs: boolean;
	/** Whether the circuit is exported */
	isExported: boolean;
	/** Parsed documentation fields */
	parsed: ParsedDoc;
	/** Parameters from the circuit signature */
	signatureParams: CircuitParam[];
	/** Return type from the circuit signature */
	signatureReturn: string;
}

/**
 * Severity level for validation issues
 */
export type Severity = "warning" | "error";

/**
 * A single validation issue
 */
export interface ValidationIssue {
	/** Issue message */
	message: string;
	/** Severity level */
	severity: Severity;
	/** Line number where the issue occurs */
	line: number;
	/** The field or component with the issue */
	field: string;
}

/**
 * Validation result for a circuit's documentation
 */
export interface ValidationResult {
	/** Circuit name */
	circuitName: string;
	/** File path */
	filePath: string;
	/** Line number of the circuit */
	line: number;
	/** Whether the documentation is valid (no warnings or errors) */
	isValid: boolean;
	/** List of validation issues */
	issues: ValidationIssue[];
}

/**
 * Summary of validation results for a file
 */
export interface FileSummary {
	/** File path */
	filePath: string;
	/** Total circuits in file */
	totalCircuits: number;
	/** Circuits with valid documentation */
	validCircuits: number;
	/** Circuits with issues */
	circuitsWithIssues: number;
	/** Total warnings */
	totalWarnings: number;
	/** Total errors */
	totalErrors: number;
}
