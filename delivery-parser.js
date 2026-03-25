(function (root, factory) {
  const exported = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
    return;
  }

  root.AmazonDeliverySorterParser = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MONTHS = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };

  const WEEKDAYS = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6
  };

  const RELEVANT_LINE_REGEX =
    /delivery|arriv|shipping|ship\b|get it|receive|overnight|same[- ]day|today|tomorrow|\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:[a-z]+)?\.?\s+\d{1,2}\b/i;
  const MONTH_DAY_REGEX =
    /\b(?:(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day)?\.?,?\s+)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/gi;
  const WEEKDAY_ONLY_REGEX =
    /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day)?\b/gi;

  function normalizeText(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function toStartOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0, 0, 0);
  }

  function addDays(date, days, hourOffset) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + days);
    copy.setHours(hourOffset || 9, 0, 0, 0);
    return copy;
  }

  function addHours(date, hours) {
    const copy = new Date(date);
    copy.setHours(copy.getHours() + hours, 0, 0, 0);
    return copy;
  }

  function coerceReferenceDate(referenceDate) {
    const value = referenceDate instanceof Date ? referenceDate : new Date(referenceDate || Date.now());
    return toStartOfDay(value);
  }

  function parseMonthDay(monthToken, dayToken, yearToken, referenceDate) {
    const monthIndex = MONTHS[String(monthToken || "").toLowerCase().replace(/\./g, "")];
    const day = Number(dayToken);

    if (Number.isNaN(monthIndex) || Number.isNaN(day)) {
      return null;
    }

    let year = yearToken ? Number(yearToken) : referenceDate.getFullYear();
    let candidate = new Date(year, monthIndex, day, 9, 0, 0, 0);

    if (candidate < addDays(referenceDate, -1, 0) && !yearToken) {
      candidate = new Date(year + 1, monthIndex, day, 9, 0, 0, 0);
    }

    return candidate;
  }

  function parseWeekday(weekdayToken, referenceDate) {
    const targetDay = WEEKDAYS[String(weekdayToken || "").toLowerCase()];

    if (typeof targetDay !== "number") {
      return null;
    }

    const currentDay = referenceDate.getDay();
    let daysAhead = (targetDay - currentDay + 7) % 7;

    if (daysAhead === 0) {
      daysAhead = 7;
    }

    return addDays(referenceDate, daysAhead, 9);
  }

  function extractRelevantTextSegments(rawText) {
    const lines = String(rawText || "")
      .split(/\n+/)
      .map(normalizeText)
      .filter(Boolean);
    const segments = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (!RELEVANT_LINE_REGEX.test(line)) {
        continue;
      }

      segments.push(line);

      if (lines[index + 1]) {
        segments.push(normalizeText(line + " " + lines[index + 1]));
      }
    }

    return Array.from(new Set(segments));
  }

  function parseDeliverySegment(segment, referenceDate) {
    const normalized = normalizeText(segment);

    if (!normalized) {
      return null;
    }

    const lower = normalized.toLowerCase();
    const candidates = [];
    const hourMatch = lower.match(/\b(?:in|within)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/);

    if (hourMatch) {
      candidates.push({
        date: addHours(referenceDate, Number(hourMatch[1])),
        match: hourMatch[0],
        certainty: "high"
      });
    }

    if (/\b(today|same[- ]day)\b/.test(lower)) {
      candidates.push({
        date: addDays(referenceDate, 0, 9),
        match: "today",
        certainty: "high"
      });
    }

    if (/\bovernight\b/.test(lower)) {
      candidates.push({
        date: addDays(referenceDate, 1, 6),
        match: "overnight",
        certainty: "medium"
      });
    }

    if (/\b(tomorrow|next[- ]day)\b/.test(lower)) {
      candidates.push({
        date: addDays(referenceDate, 1, 9),
        match: "tomorrow",
        certainty: "high"
      });
    }

    const dayCountMatch = lower.match(/\b(\d+)[ -]?day\b/);
    if (dayCountMatch) {
      candidates.push({
        date: addDays(referenceDate, Number(dayCountMatch[1]), 9),
        match: dayCountMatch[0],
        certainty: "medium"
      });
    }

    let explicitMatch;
    let foundExplicitDate = false;
    MONTH_DAY_REGEX.lastIndex = 0;
    while ((explicitMatch = MONTH_DAY_REGEX.exec(normalized)) !== null) {
      const parsed = parseMonthDay(
        explicitMatch[2],
        explicitMatch[3],
        explicitMatch[4],
        referenceDate
      );

      if (!parsed) {
        continue;
      }

      candidates.push({
        date: parsed,
        match: explicitMatch[0],
        certainty: "high"
      });
      foundExplicitDate = true;
    }

    if (!foundExplicitDate) {
      let weekdayMatch;
      WEEKDAY_ONLY_REGEX.lastIndex = 0;
      while ((weekdayMatch = WEEKDAY_ONLY_REGEX.exec(normalized)) !== null) {
        const parsed = parseWeekday(weekdayMatch[1], referenceDate);

        if (!parsed) {
          continue;
        }

        candidates.push({
          date: parsed,
          match: weekdayMatch[0],
          certainty: "medium"
        });
      }
    }

    if (!candidates.length) {
      return null;
    }

    candidates.sort(function (left, right) {
      return left.date.getTime() - right.date.getTime();
    });

    return {
      isKnown: true,
      date: candidates[0].date,
      timestamp: candidates[0].date.getTime(),
      matchedText: candidates[0].match,
      sourceText: normalized,
      certainty: candidates[0].certainty
    };
  }

  function parseDeliveryEstimate(rawText, referenceDateInput) {
    const referenceDate = coerceReferenceDate(referenceDateInput);
    const segments = extractRelevantTextSegments(rawText);
    const parsedSegments = segments
      .map(function (segment) {
        return parseDeliverySegment(segment, referenceDate);
      })
      .filter(Boolean)
      .sort(function (left, right) {
        return left.timestamp - right.timestamp;
      });

    if (!parsedSegments.length) {
      return {
        isKnown: false,
        date: null,
        timestamp: Number.POSITIVE_INFINITY,
        matchedText: null,
        sourceText: null,
        certainty: "none"
      };
    }

    return parsedSegments[0];
  }

  return {
    extractRelevantTextSegments: extractRelevantTextSegments,
    parseDeliveryEstimate: parseDeliveryEstimate,
    parseDeliverySegment: parseDeliverySegment
  };
});
