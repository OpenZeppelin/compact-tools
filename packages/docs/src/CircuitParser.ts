import { readFileSync } from "node:fs";
import type {
	CircuitDoc,
	CircuitParam,
	DocParam,
	DocThrows,
	ParsedDoc,
} from "./types.js";

/**
 * Parser for extracting exported circuits and their documentation from Compact files.
 * Parses both the circuit signature (parameters, return type) and the JSDoc-style documentation.
 */
export class CircuitParser {
	/**
	 * Parses a Compact file and extracts all exported circuits with their documentation
	 */
	parseFile(filePath: string): CircuitDoc[] {
		const content = readFileSync(filePath, "utf-8");
		return this.parseContent(content);
	}

	/**
	 * Parses content string and extracts all exported circuits with their documentation
	 */
	parseContent(content: string): CircuitDoc[] {
		const lines = content.split("\n");
		const circuits: CircuitDoc[] = [];
		let i = 0;

		while (i < lines.length) {
			// Look for circuit declarations (both exported and non-exported)
			const circuitMatch = lines[i].match(
				/^(export\s+)?(pure\s+)?circuit\s+(\w+)\s*\(/,
			);

			if (circuitMatch) {
				const isExported = !!circuitMatch[1];
				const circuitName = circuitMatch[3];
				const circuitLine = i + 1; // 1-indexed line number

				// Parse the circuit signature (parameters and return type)
				const { params, returnType } = this.parseSignature(lines, i);

				// Look backwards for documentation comment
				const { docComment, docStartLine, docEndLine } =
					this.findDocComment(lines, i);

				// Parse the documentation
				const parsed = this.parseDocComment(docComment);

				circuits.push({
					name: circuitName,
					docComment,
					circuitLine,
					docStartLine,
					docEndLine,
					hasDocs: docComment.length > 0,
					isExported,
					parsed,
					signatureParams: params,
					signatureReturn: returnType,
				});
			}
			i++;
		}

		return circuits;
	}

	/**
	 * Finds the documentation comment block above a circuit declaration
	 */
	private findDocComment(
		lines: string[],
		circuitLineIndex: number,
	): { docComment: string; docStartLine: number; docEndLine: number } {
		let docStart = circuitLineIndex - 1;
		let docEnd = circuitLineIndex - 1;
		let docComment = "";

		// Skip empty lines and find the end of doc comment (*/)
		while (docStart >= 0 && lines[docStart].trim() === "") {
			docStart--;
		}

		// Check if we're at the end of a doc comment
		if (docStart >= 0 && lines[docStart].trim().endsWith("*/")) {
			docEnd = docStart;

			// Find the start of the documentation block (/**)
			while (docStart >= 0 && !lines[docStart].trim().startsWith("/**")) {
				docStart--;
			}

			if (docStart >= 0 && lines[docStart].trim().startsWith("/**")) {
				// Extract the full documentation comment
				docComment = lines
					.slice(docStart, docEnd + 1)
					.join("\n")
					.trim();

				return {
					docComment,
					docStartLine: docStart + 1, // 1-indexed
					docEndLine: docEnd + 1, // 1-indexed
				};
			}
		}

		return {
			docComment: "",
			docStartLine: circuitLineIndex + 1,
			docEndLine: circuitLineIndex + 1,
		};
	}

	/**
	 * Parses the circuit signature to extract parameters and return type
	 */
	private parseSignature(
		lines: string[],
		startLineIndex: number,
	): { params: CircuitParam[]; returnType: string } {
		// Collect the full signature (may span multiple lines)
		let signature = "";
		let i = startLineIndex;
		let braceCount = 0;
		let foundOpenParen = false;
		let foundCloseParen = false;

		while (i < lines.length) {
			signature += lines[i];

			// Count parentheses to find the complete parameter list
			for (const char of lines[i]) {
				if (char === "(") {
					foundOpenParen = true;
					braceCount++;
				} else if (char === ")") {
					braceCount--;
					if (braceCount === 0 && foundOpenParen) {
						foundCloseParen = true;
					}
				}
			}

			// Check if we have the return type (after the closing paren)
			if (foundCloseParen && lines[i].includes(":")) {
				break;
			}

			i++;
		}

		// Extract parameters from signature
		const params = this.extractParams(signature);

		// Extract return type
		const returnType = this.extractReturnType(signature);

		return { params, returnType };
	}

	/**
	 * Extracts parameters from a circuit signature string
	 */
	private extractParams(signature: string): CircuitParam[] {
		const params: CircuitParam[] = [];

		// Find the parameter list between first ( and matching )
		const parenStart = signature.indexOf("(");
		if (parenStart === -1) return params;

		let parenCount = 0;
		let parenEnd = parenStart;
		for (let i = parenStart; i < signature.length; i++) {
			if (signature[i] === "(") parenCount++;
			else if (signature[i] === ")") {
				parenCount--;
				if (parenCount === 0) {
					parenEnd = i;
					break;
				}
			}
		}

		const paramStr = signature.slice(parenStart + 1, parenEnd).trim();
		if (!paramStr) return params;

		// Split by comma, but be careful of nested types like Either<A, B>
		const paramParts = this.splitParams(paramStr);

		for (const part of paramParts) {
			const trimmed = part.trim();
			if (!trimmed) continue;

			// Match "name: Type" pattern
			const match = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
			if (match) {
				params.push({
					name: match[1],
					type: match[2].trim().replace(/,\s*$/, ""),
				});
			}
		}

		return params;
	}

	/**
	 * Splits parameter string by commas, respecting nested angle brackets
	 */
	private splitParams(paramStr: string): string[] {
		const parts: string[] = [];
		let current = "";
		let angleCount = 0;

		for (const char of paramStr) {
			if (char === "<") {
				angleCount++;
				current += char;
			} else if (char === ">") {
				angleCount--;
				current += char;
			} else if (char === "," && angleCount === 0) {
				parts.push(current);
				current = "";
			} else {
				current += char;
			}
		}

		if (current.trim()) {
			parts.push(current);
		}

		return parts;
	}

	/**
	 * Extracts the return type from a circuit signature
	 */
	private extractReturnType(signature: string): string {
		// Find the return type after ):
		// Pattern: ): ReturnType {
		const match = signature.match(/\)\s*:\s*([^{]+)/);
		if (match) {
			return match[1].trim();
		}
		return "[]"; // Default return type
	}

	/**
	 * Parses a documentation comment block into structured fields
	 */
	parseDocComment(docComment: string): ParsedDoc {
		const parsed: ParsedDoc = {
			params: [],
			throws: [],
		};

		if (!docComment) {
			return parsed;
		}

		// Normalize the doc comment - remove leading * and whitespace from each line
		const normalizedDoc = this.normalizeDocComment(docComment);

		// Extract @title
		const titleMatch = normalizedDoc.match(
			/@title\s+(.+?)(?=\n\s*@|\n\s*$|$)/s,
		);
		if (titleMatch) {
			parsed.title = this.cleanMultilineText(titleMatch[1]);
		}

		// Extract @description
		const descriptionMatch = normalizedDoc.match(
			/@description\s+(.+?)(?=\n\s*@|\n\s*$|$)/s,
		);
		if (descriptionMatch) {
			parsed.description = this.cleanMultilineText(descriptionMatch[1]);
		}

		// Extract @remarks (may include Requirements section)
		const remarksMatch = normalizedDoc.match(
			/@remarks\s+(.+?)(?=\n\s*@(?!remarks)|\n\s*$|$)/s,
		);
		if (remarksMatch) {
			parsed.remarks = this.cleanMultilineText(remarksMatch[1]);
		}

		// Extract @circuitInfo
		const circuitInfoMatch = normalizedDoc.match(
			/@circuitInfo\s+(.+?)(?=\n\s*@|\n\s*$|$)/s,
		);
		if (circuitInfoMatch) {
			parsed.circuitInfo = this.cleanMultilineText(circuitInfoMatch[1]);
		}

		// Extract @param entries
		const paramMatches = normalizedDoc.matchAll(
			/@param\s+\{([^}]+)\}\s+(\w+)\s*-?\s*(.+?)(?=\n\s*@|\n\s*$|$)/gs,
		);
		for (const match of paramMatches) {
			parsed.params.push({
				name: match[2],
				type: match[1].trim(),
				description: this.cleanMultilineText(match[3]),
			});
		}

		// Extract @throws entries
		const throwsMatches = normalizedDoc.matchAll(
			/@throws\s+\{([^}]+)\}\s*(.+?)(?=\n\s*@|\n\s*$|$)/gs,
		);
		for (const match of throwsMatches) {
			parsed.throws.push({
				type: match[1].trim(),
				message: this.cleanMultilineText(match[2]),
			});
		}

		// Extract @returns (with or without description)
		const returnsMatch = normalizedDoc.match(
			/@returns?\s+(?:\{([^}]+)\})?\s*-?\s*(.+?)(?=\n\s*@|\n\s*$|$)/s,
		);
		if (returnsMatch) {
			parsed.returns = {
				type: returnsMatch[1]?.trim() || "",
				description: this.cleanMultilineText(returnsMatch[2] || ""),
			};
		}

		return parsed;
	}

	/**
	 * Normalizes a JSDoc comment by removing leading asterisks and cleaning whitespace
	 */
	private normalizeDocComment(docComment: string): string {
		return docComment
			.replace(/^\/\*\*\s*/, "") // Remove opening /**
			.replace(/\s*\*\/$/, "") // Remove closing */
			.split("\n")
			.map((line) => line.replace(/^\s*\*\s?/, "")) // Remove leading * from each line
			.join("\n")
			.trim();
	}

	/**
	 * Cleans multiline text by removing extra whitespace and normalizing newlines
	 */
	private cleanMultilineText(text: string): string {
		return text
			.split("\n")
			.map((line) => line.trim())
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}
}

