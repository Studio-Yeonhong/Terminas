import type { ITheme } from '@xterm/xterm';

export type TermTheme = { id: string; name: string; theme: Required<Pick<ITheme, 'background' | 'foreground'>> & ITheme };

export const TERM_THEMES: TermTheme[] = [
  {
    id: 'studio-dark',
    name: 'Studio Dark',
    theme: {
      background: '#141824',
      foreground: '#d6dbe8',
      cursor: '#6ea8ff',
      cursorAccent: '#141824',
      selectionBackground: '#2d4270',
      black: '#232838',
      red: '#ff6b7d',
      green: '#4fd69c',
      yellow: '#f5c565',
      blue: '#6ea8ff',
      magenta: '#c792ea',
      cyan: '#56d4e0',
      white: '#c9cfdd',
      brightBlack: '#5a6378',
      brightRed: '#ff8a98',
      brightGreen: '#6fe3b0',
      brightYellow: '#ffd98a',
      brightBlue: '#94beff',
      brightMagenta: '#dbb0f5',
      brightCyan: '#86e6ef',
      brightWhite: '#f2f4f9',
    },
  },
  {
    id: 'studio-light',
    name: 'Studio Light',
    theme: {
      background: '#fbfbfd',
      foreground: '#2a2f3b',
      cursor: '#2f6fe0',
      cursorAccent: '#fbfbfd',
      selectionBackground: '#cfdcf7',
      black: '#2a2f3b',
      red: '#d6334a',
      green: '#1f9d6a',
      yellow: '#b7860b',
      blue: '#2f6fe0',
      magenta: '#9b4fd1',
      cyan: '#138a9b',
      white: '#8a90a0',
      brightBlack: '#5c6272',
      brightRed: '#e8566b',
      brightGreen: '#2bb981',
      brightYellow: '#d19d1c',
      brightBlue: '#4d87f0',
      brightMagenta: '#b06ee3',
      brightCyan: '#1fa6b8',
      brightWhite: '#b5bac6',
    },
  },
  {
    id: 'hacker-green',
    name: 'Phosphor',
    theme: {
      background: '#0b120d',
      foreground: '#7cf29a',
      cursor: '#7cf29a',
      selectionBackground: '#1f4a2b',
      black: '#0b120d',
      red: '#ff6b6b',
      green: '#7cf29a',
      yellow: '#d8f27c',
      blue: '#5fd3a5',
      magenta: '#a0e8b0',
      cyan: '#6fe8d0',
      white: '#b9f5c8',
      brightBlack: '#3f6b4b',
      brightGreen: '#a8ffbe',
      brightWhite: '#e2ffe9',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      selectionBackground: '#0a4452',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#839496',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
];

export function termTheme(id: string) {
  return TERM_THEMES.find((t) => t.id === id) ?? TERM_THEMES[0];
}

export type Prefs = { fontSize: number; themeId: string; cursorBlink: boolean; view: 'grid' | 'list'; hostSort: 'name' | 'tag' };

const DEFAULT_PREFS: Prefs = { fontSize: 14, themeId: 'studio-dark', cursorBlink: true, view: 'grid', hostSort: 'name' };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('shell.prefs') ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem('shell.prefs', JSON.stringify(p));
  } catch {}
}
