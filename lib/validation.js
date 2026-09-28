// Small validation and sanitising helpers used across routes.

// Convert common input types into a safe string for validation.
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

// Remove control characters that should not appear in user text fields.
function stripControlChars(text) {
    // Keep newline and tab, remove other control characters.
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// Normalise newlines and trim whitespace at both ends.
function trimAndNormalise(text) {
    // Normalise Windows newlines and trim whitespace at the edges.
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

// Collapse repeated whitespace into a single space for neat display/storage.
function collapseWhitespace(text) {
    return text.replace(/\s+/g, ' ').trim();
}

// Sanitise a single-line text input (strip control chars, collapse whitespace, limit length).
function cleanSingleLine(value, maxLen) {
    const raw = toStringSafe(value);
    const cleaned = collapseWhitespace(trimAndNormalise(stripControlChars(raw)));
    if (typeof maxLen === 'number' && maxLen > 0) {
        return cleaned.slice(0, maxLen);
    }
    return cleaned;
}

// Sanitise a multi-line text input (strip control chars, trim, limit length).
function cleanMultiLine(value, maxLen) {
    const raw = toStringSafe(value);
    const cleaned = trimAndNormalise(stripControlChars(raw));
    if (typeof maxLen === 'number' && maxLen > 0) {
        return cleaned.slice(0, maxLen);
    }
    return cleaned;
}

// Check whether a field has a non-empty value after trimming.
function isNonEmpty(text) {
    return typeof text === 'string' && text.trim().length > 0;
}

// Parse a value into a non-negative integer with a safe fallback.
function toNonNegativeInt(value, allowBlank) {
    const cleaned = cleanSingleLine(value, 50);
    if (cleaned.length === 0) {
        return allowBlank ? 0 : null;
    }
    if (!/^\d+$/.test(cleaned)) {
        return null;
    }
    const n = Number.parseInt(cleaned, 10);
    if (!Number.isSafeInteger(n) || n < 0) {
        return null;
    }
    return n;
}

// Parse a numeric value into a safe money amount with two decimals.
function toMoney(value) {
    const cleaned = cleanSingleLine(value, 50);
    if (cleaned.length === 0) {
        return null;
    }
    // Allow simple decimal input.
    if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
        return null;
    }
    const n = Number(cleaned);
    if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100)) || n < 0) {
        return null;
    }
    return Math.round(n * 100) / 100;
}

// Validate a YYYY-MM-DD date string.
function isISODate(value) {
    const cleaned = cleanSingleLine(value, 20);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
        return false;
    }
    const d = new Date(cleaned + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === cleaned;
}

// Strip everything except digits from an input value.
function cleanDigits(value, maxLen) {
    // Keep only digits. For Student ID
    const raw = toStringSafe(value);
    const digitsOnly = raw.replace(/\D+/g, '');
    if (typeof maxLen === 'number' && maxLen > 0) {
        return digitsOnly.slice(0, maxLen);
    }
    return digitsOnly;
}

// Validate a student ID as exactly 13 digits.
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
