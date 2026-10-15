const levenshtein = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
};

/** Returns the closest candidate when it is plausibly a typo of `name`. */
export const closestMatch = (name: string, candidates: Iterable<string>): string | undefined => {
  const maxDistance = Math.max(2, Math.floor(name.length / 3));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(name.toLowerCase(), candidate.toLowerCase());
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  return best?.candidate;
};

export const didYouMean = (name: string, candidates: Iterable<string>): string | undefined => {
  const match = closestMatch(name, candidates);
  return match ? `Did you mean \`${match}\`?` : undefined;
};
