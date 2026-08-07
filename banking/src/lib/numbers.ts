import { getCurrencyNumberFormat, getCurrencyProperty, getCurrencySymbol } from "./currency";
import { getSystemDefault } from "./frappe";
import _ from "@/lib/translate";

export const formatCurrency = (value?: number, currency: string = '', decimals: number = 2) => {

    if (!value) {
        value = 0
    }

    if (!currency) {
        currency = getSystemDefault('currency') ?? ''
    }
    const format = get_number_format(currency);
    const symbol = getCurrencySymbol(currency);

    const show_symbol_on_right = getCurrencyProperty(currency, 'symbol_on_right') ?? false;

    if (decimals === undefined) {
        decimals = getSystemDefault('currency_precision') || null;
    }

    if (symbol) {
        if (show_symbol_on_right) {
            return format_number(value, format, decimals) + " " + _(symbol);
        }
        return _(symbol) + " " + format_number(value, format, decimals);
    } else {
        return format_number(value, format, decimals);
    }
}

const replace_all = (str: string, search: string, replace: string) => {
    return str.split(search).join(replace);
};

const number_format_info = {
    "#,###.##": { decimal_str: ".", group_sep: "," },
    "#.###,##": { decimal_str: ",", group_sep: "." },
    "# ###.##": { decimal_str: ".", group_sep: " " },
    "# ###,##": { decimal_str: ",", group_sep: " " },
    "#'###.##": { decimal_str: ".", group_sep: "'" },
    "#, ###.##": { decimal_str: ".", group_sep: ", " },
    "#,##,###.##": { decimal_str: ".", group_sep: "," },
    "#,###.###": { decimal_str: ".", group_sep: "," },
    "#.###": { decimal_str: "", group_sep: "." },
    "#,###": { decimal_str: "", group_sep: "," },
};

const format_number = (v?: number, format?: string, decimals?: number | null) => {
    if (!format) {
        format = get_number_format();
        if (decimals == null) decimals = cint(getSystemDefault("float_precision")) || 3;
    }

    const info = get_number_format_info(format);

    // Fix the decimal first, toFixed will auto fill trailing zero.
    if (decimals == null) decimals = info.precision;

    v = flt(v, decimals, format);

    let is_negative = false;
    if (v < 0) is_negative = true;
    v = Math.abs(v);

    const val = v.toFixed(decimals)

    const part = val.split(".");

    // get group position and parts
    let group_position = info.group_sep ? 3 : 0;

    if (group_position) {
        const integer = part[0];
        let str = "";
        for (let i = integer.length; i >= 0; i--) {
            let l = replace_all(str, info.group_sep, "").length;
            if (format == "#,##,###.##" && str.indexOf(",") != -1) {
                // INR
                group_position = 2;
                l += 1;
            }

            str += integer.charAt(i);

            if (l && !((l + 1) % group_position) && i != 0) {
                str += info.group_sep;
            }
        }
        part[0] = str.split("").reverse().join("");
    }
    if (part[0] + "" == "") {
        part[0] = "0";
    }

    // join decimal
    part[1] = part[1] && info.decimal_str ? info.decimal_str + part[1] : "";

    // join
    return (is_negative ? "-" : "") + part[0] + part[1];
};

function get_number_format_info(format: string) {
    let info: { decimal_str: string, group_sep: string, precision?: number } = number_format_info[format as keyof typeof number_format_info];

    if (!info) {
        info = { decimal_str: ".", group_sep: "," };
    }

    // get the precision from the number format
    info.precision = format.split(info.decimal_str).slice(1)[0].length;

    return info;
}

function get_number_format(currency?: string): string {
    return (
        (cint(getSystemDefault("use_number_format_from_currency")) &&
            currency &&
            getCurrencyNumberFormat(currency)) ||
        getSystemDefault("number_format") ||
        "#,###.##"
    )
}

export const flt = (value?: number | string | null, decimals?: number, number_format?: string, rounding_method?: string) => {
    if (value === undefined || value === null || value === "") return 0

    if (typeof value !== "number") {
        value = value + "";

        // strip currency symbol if exists
        if (value.indexOf(" ") != -1) {
            // using slice(1).join(" ") because space could also be a group separator
            const parts = value.split(" ");
            value = isNaN(parseFloat(parts[0])) ? parts.slice(parts.length - 1).join(" ") : value;
        }

        value = strip_number_groups(value, number_format);

        value = parseFloat(value as string);
        if (isNaN(value)) value = 0;
    }

    if (decimals != null) return _round(value, decimals, rounding_method);
    return value;
}

function strip_number_groups(v: string, number_format?: string) {
    if (!number_format) number_format = get_number_format();
    const info = get_number_format_info(number_format);

    // strip groups (,)
    const group_regex = new RegExp(info.group_sep === "." ? "\\." : info.group_sep, "g");
    v = v.replace(group_regex, "");

    // replace decimal separator with (.)
    if (info.decimal_str !== "." && info.decimal_str !== "") {
        const decimal_regex = new RegExp(info.decimal_str, "g");
        v = v.replace(decimal_regex, ".");
    }

    return v;
}

const _round = (num: number, precision: number, rounding_method?: string) => {

    rounding_method = rounding_method || getSystemDefault('rounding_method') || "Banker's Rounding (legacy)";

    const is_negative = num < 0 ? true : false;

    if (rounding_method == "Banker's Rounding (legacy)") {
        const d = cint(precision);
        const m = Math.pow(10, d);
        const n = +(d ? Math.abs(num) * m : Math.abs(num)).toFixed(8); // Avoid rounding errors
        const i = Math.floor(n),
            f = n - i;
        let r = !precision && f == 0.5 ? (i % 2 == 0 ? i : i + 1) : Math.round(n);
        r = d ? r / m : r;
        return is_negative ? -r : r;
    } else if (rounding_method == "Banker's Rounding") {
        if (num == 0) return 0.0;
        precision = cint(precision);

        const multiplier = Math.pow(10, precision);
        num = Math.abs(num) * multiplier;

        const floor_num = Math.floor(num);
        const decimal_part = num - floor_num;

        // For explanation of this method read python flt implementation notes.
        const epsilon = 2.0 ** (Math.log2(Math.abs(num)) - 52.0);

        if (Math.abs(decimal_part - 0.5) < epsilon) {
            num = floor_num % 2 == 0 ? floor_num : floor_num + 1;
        } else {
            num = Math.round(num);
        }
        num = num / multiplier;
        return is_negative ? -num : num;
    } else if (rounding_method == "Commercial Rounding") {
        if (num == 0) return 0.0;

        const digits = cint(precision);
        const multiplier = Math.pow(10, digits);

        num = num * multiplier;

        // For explanation of this method read python flt implementation notes.
        let epsilon = 2.0 ** (Math.log2(Math.abs(num)) - 52.0);
        if (is_negative) {
            epsilon = -1 * epsilon;
        }

        num = Math.round(num + epsilon);
        return num / multiplier;
    } else {
        throw new Error(`Unknown rounding method ${rounding_method}`);
    }
}


export const cint = (v: boolean | string | number, def?: boolean | string | number) => {
    if (v === true) return 1;
    if (v === false) return 0;
    v = v + "";
    if (v !== "0") v = lstrip(v, ["0"]);
    v = parseInt(v); // eslint-ignore-line
    if (isNaN(v)) v = def === undefined ? 0 : def;
    return v as number;
};

export const lstrip = (s: string, chars?: string[]) => {
    if (!chars) chars = ["\n", "\t", " "];
    // strip left
    let first_char = s.substring(0, 1);
    while (chars.includes(first_char)) {
        s = s.substring(1);
        first_char = s.substring(0, 1);
    }
    return s;
};

export const getCurrencyFormatInfo = (currency?: string) => {
    const format = get_number_format(currency);
    return get_number_format_info(format);
};
/**
 * What a currency input's `onValueChange` reports, narrowed to the parts worth trusting.
 *
 * `react-currency-input-field` hands back three things: the text now in the field, and - in its third
 * argument - a `float` it parsed from that text. The float is the ONLY reliable number of the three.
 */
export type CurrencyInputChange = {
    /** The text currently in the field, exactly as the library left it after its own sanitisation. */
    text?: string
    /** The library's parsed value: `null` for an empty field, and for text it could not parse. */
    float?: number | null
    /** The decimal separator in force for this currency. Defaults to `.`. */
    decimalSeparator?: string
}

/**
 * The outcome of reading a currency input.
 */
export type ParsedCurrencyInput = {
    /** The number to use, or `null` when the field carries no usable number. */
    value: number | null
    /** The text to keep in the field, so a half-typed decimal survives the round trip. */
    text: string
    /**
     * Whether the field currently holds something that cannot be used as a number. An empty field is
     * NOT invalid - it simply carries no value.
     */
    isInvalid: boolean
    /**
     * Whether the TEXT must be echoed back rather than the number, because the entry is mid-decimal.
     *
     * A field controlled by the parsed number cannot be typed into past the decimal point: `250.`
     * parses to 250, echoing `250` back drops the separator the reviewer just pressed, and the next
     * digit lands in the units - which is how `250.50` became 25050. While the entry is unfinished the
     * text is authoritative and the number is not yet.
     */
    keepText: boolean
}

/**
 * Reads a currency input strictly, so what is filtered or saved is always what is displayed.
 *
 * WHY THIS EXISTS. The two currency inputs in this application used to store "the string while a decimal
 * is being typed, otherwise the parsed float", and then ran `Number()` over that union. Every failure
 * mode observed in testing came from those two decisions together:
 *
 *   - `Number()` over a GROUPED string is `NaN` - `Number('1,234.')` - which is how a filter came to
 *     display `NaN` and match nothing;
 *   - a partially-typed value could be re-parsed against a different decimal position, turning 1.23 into
 *     1,230,000,000;
 *   - a value the library had truncated was stored silently, so `12ab34` filtered on 12 with nothing said;
 *   - a negative could lose its sign on the round trip.
 *
 * Taking the library's own parsed float, and keeping the raw text only for display, removes all four:
 * the number never comes from re-parsing formatted text, and text that yields no number is REPORTED
 * rather than quietly coerced to one.
 *
 * @param change what the input reported
 * @returns the usable number (or `null`), the text to echo back, and whether the text is unusable
 */
export const parseCurrencyInput = (change: CurrencyInputChange): ParsedCurrencyInput => {
    const text = change.text ?? ''
    const trimmed = text.trim()

    const decimalSeparator = change.decimalSeparator || '.'

    // An empty field carries no value and is not an error: it is how a filter is switched off.
    if (trimmed === '') {
        return { value: null, text, isInvalid: false, keepText: false }
    }

    /*
     * A decimal being typed: the separator has been pressed and nothing significant follows it yet.
     * Trailing zeroes count as unfinished too - `1.0` on the way to `1.05` parses to 1, and echoing `1`
     * back would swallow both keystrokes.
     */
    const isMidDecimal = new RegExp(`\\${decimalSeparator}0*$`).test(trimmed)

    const float = change.float

    if (typeof float === 'number' && Number.isFinite(float)) {
        return { value: float, text, isInvalid: false, keepText: isMidDecimal }
    }

    /*
     * The library reports `null` mid-entry for text that is a legitimate prefix of a number - a lone
     * minus sign, or a bare decimal separator. Those are not errors, they are unfinished, so the text is
     * kept and no value is offered yet.
     */
    const isPrefix = new RegExp(`^-?\\${decimalSeparator}?$`).test(trimmed)

    return { value: null, text, isInvalid: !isPrefix, keepText: isPrefix }
}

/**
 * Turns whatever a currency field is holding into a number, or `null` when it holds no figure.
 *
 * A currency field's value is a union: a number once the entry parses, or the displayed TEXT while a
 * decimal is being typed (see {@link ParsedCurrencyInput.keepText}). Consumers must not run `Number()`
 * over that text directly - it can carry group separators, and `Number('1,234.')` is `NaN`, which is how
 * a filter came to display `NaN` and a saved balance came to be rejected. This normalises the text first.
 *
 * @param raw the field's current value
 * @param separators the group and decimal separators in force for the currency
 * @returns a finite number, or `null` when the field holds nothing usable
 */
export const currencyInputValueToNumber = (
    raw: unknown,
    separators: { groupSeparator?: string, decimalSeparator?: string } = {}
): number | null => {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? raw : null
    }

    if (typeof raw !== 'string') {
        return null
    }

    const groupSeparator = separators.groupSeparator || ','
    const decimalSeparator = separators.decimalSeparator || '.'

    const normalised = replace_all(replace_all(raw.trim(), groupSeparator, ''), decimalSeparator, '.')

    if (normalised === '') {
        return null
    }

    const parsed = Number(normalised)
    return Number.isFinite(parsed) ? parsed : null
}
