/** Puste pole opcjonalne: tak wysyła je Power Automate po wyczyszczeniu pola albo z pustą wartością dynamiczną. */
function isEmpty(value: unknown): boolean {
  return value === '' || value === null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Kopia body żądania bez właściwości równych `""` albo `null`, żeby puste pole opcjonalne
 * znaczyło to samo, co pole pominięte. Dla nazw z `nested` (tablice obiektów, na przykład
 * odbiorcy rozsyłki) to samo w każdym elemencie. Pola wymagane dalej sprawdza schemat.
 */
export function dropEmptyFields(body: unknown, nested: string[] = []): unknown {
  if (!isPlainObject(body)) return body;
  return Object.fromEntries(
    Object.entries(body)
      .filter(([, value]) => !isEmpty(value))
      .map(([name, value]) => [name, nested.includes(name) && Array.isArray(value)
        ? value.map((item) => dropEmptyFields(item))
        : value]),
  );
}
