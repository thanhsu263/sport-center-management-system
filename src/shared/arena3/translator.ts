type Translator = (en: string, vars?: Record<string, string | number>) => string;

let activeTranslator: Translator = (s) => s;

export function registerTranslator(fn: Translator) {
  activeTranslator = fn;
}

export function t(en: string, vars?: Record<string, string | number>): string {
  return activeTranslator(en, vars);
}

export const tk = <S extends string>(en: S): S => en;
