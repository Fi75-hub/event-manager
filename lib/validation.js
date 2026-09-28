// Small validation and sanitising helpers used across routes.

// Purpose: Convert common input types into a safe string for validation.
// Inputs: value (any)
// Outputs: String value (empty string if not usable)
function toStringSafe(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }

    // Express can sometimes hand us arrays if the same field name is repeated.
    if (Array.isArray(value) && value.length > 0) {
        return toStringSafe(value[0]);
    }

    return '';
}

// Purpose: Remove control characters that should not appear in user text fields.
// Inputs: text (string)
// Outputs: Cleaned string without control characters
function stripControlChars(text) {
    // Keep newline and tab, remove other control characters.
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// Purpose: Normalise newlines and trim whitespace at both ends.
// Inputs: text (string)
// Outputs: Trimmed string with normalised newlines
function trimAndNormalise(text) {
    // Normalise Windows newlines and trim whitespace at the edges.
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

// Purpose: Collapse repeated whitespace into a single space for neat display/storage.
// Inputs: text (string)
// Outputs: Whitespace-collapsed string
function collapseWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}

// Purpose: Sanitise a single-line text input (strip control chars, collapse whitespace, limit length).
// Inputs: value (any), maxLen (number, optional)
// Outputs: Clean single-line string
function cleanSingleLine(value, maxLen) {
    const raw = toStringSafe(value);
    const cleaned = collapseWhitespace(trimAndNormalise(stripControlChars(raw)));
    if (typeof maxLen === 'number' && maxLen > 0) {
        return cleaned.slice(0, maxLen);
    }
    return cleaned;
}

// Purpose: Sanitise a multi-line text input (strip control chars, trim, limit length).
// Inputs: value (any), maxLen (number, optional)
// Outputs: Clean multi-line string
function cleanMultiLine(value, maxLen) {
    const raw = toStringSafe(value);
    const cleaned = trimAndNormalise(stripControlChars(raw));
    if (typeof maxLen === 'number' && maxLen > 0) {
        return cleaned.slice(0, maxLen);
    }
    return cleaned;
}

// Purpose: Check whether a field has a non-empty value after trimming.
// Inputs: value (any)
// Outputs: Boolean
function isNonEmpty(text) {
    return typeof text === 'string' && text.trim().length > 0;
}

// Purpose: Parse a value into a non-negative integer with a safe fallback.
// Inputs: value (any), fallback (number, optional)
// Outputs: Number (integer)
function toNonNegativeInt(value, allowBlank) {
    const cleaned = cleanSingleLine(value, 50);
    if (cleaned.length === 0) {
        return allowBlank ? 0 : null;
    }
    if (!/^\d+$/.test(cleaned)) {
        return null;
    }
    const n = Number.parseInt(cleaned, 10);
    if (!Number.isFinite(n) || n < 0) {
        return null;
    }
    return n;
}

// Purpose: Parse a numeric value into a safe money amount with two decimals.
// Inputs: value (any), fallback (number, optional)
// Outputs: Number (money value)
function toMoney(value) {
    const cleaned = cleanSingleLine(value, 50);
    if (cleaned.length === 0) {
        return null;
    }
    // Allow simple decimal input.
    const n = Number.parseFloat(cleaned);
    if (!Number.isFinite(n) || n < 0) {
        return null;
    }
    return Math.round(n * 100) / 100;
}

// Purpose: Validate a YYYY-MM-DD date string.
// Inputs: value (string)
// Outputs: Boolean
function isISODate(value) {
    const cleaned = cleanSingleLine(value, 20);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
        return false;
    }
    const d = new Date(cleaned + 'T00:00:00Z');
    return !Number.isNaN(d.getTime());
}

// Purpose: Strip everything except digits from an input value.
// Inputs: value (any), maxLen (number, optional)
// Outputs: Digit-only string
function cleanDigits(value, maxLen) {
    // Keep only digits. For Student ID
    const raw = toStringSafe(value);
    const digitsOnly = raw.replace(/\D+/g, '');
    if (typeof maxLen === 'number' && maxLen > 0) {
        return digitsOnly.slice(0, maxLen);
    }
    return digitsOnly;
}

// Purpose: Validate a student ID as exactly 13 digits.
// Inputs: value (string)
// Outputs: Boolean
function isStudentId(value) {
    // Student IDs are treated as 13 digits for the booking form.
    const digits = cleanDigits(value, 20);
    return /^\d{13}$/.test(digits);
}

module.exports = {
    toStringSafe,
    cleanSingleLine,
    cleanMultiLine,
    isNonEmpty,
    toNonNegativeInt,
    toMoney,
    isISODate,
    cleanDigits,
    isStudentId
};
