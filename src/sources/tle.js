function isTleDataLine(line) {
  return (
    (line.startsWith('1 ') || line.startsWith('2 ')) &&
    tleCatalogNumber(line) !== null
  );
}

/**
 * Parse TLE catalog text into `{ name, line1, line2 }` entries.
 * Sets missing line 1 or line 2 are skipped individually without desynchronizing
 * or dropping subsequent entries in the group.
 */
export function parseTleText(text) {
  const lines = String(text)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line1 = lines[i];
    const line2 = lines[i + 1];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      const cat1 = tleCatalogNumber(line1);
      const cat2 = tleCatalogNumber(line2);
      if (cat1 !== null && cat2 !== null && cat1 !== cat2) {
        continue;
      }
      const prevLine = i > 0 ? lines[i - 1] : '';
      const name =
        prevLine && !isTleDataLine(prevLine)
          ? prevLine
          : `CATALOG-${cat1 ?? 'UNKNOWN'}`;
      result.push({ name, line1, line2 });
      i++;
    }
  }
  return result;
}

/** The NORAD catalog number from TLE line 1 or line 2, or null. */
export function tleCatalogNumber(line1) {
  const number = Number.parseInt(String(line1).slice(2, 7), 10);
  return Number.isInteger(number) ? number : null;
}
