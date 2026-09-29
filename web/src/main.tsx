import { createRoot } from 'react-dom/client';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import { App } from './App';
import { desktop, legacyApp } from './desktop';
import { initLang } from './i18n';

const app = desktop ?? legacyApp;
if (app) document.documentElement.classList.add('desktop', `platform-${app.platform}`);

// StrictMode 는 쓰지 않는다: 개발 모드에서 터미널 WebSocket 이 두 번 열려 SSH 접속이 두 번 시도된다
// 화면 언어 사전을 먼저 불러온다 (없으면 한국어로)
void initLang()
  .catch(() => {})
  .then(() => createRoot(document.getElementById('root')!).render(<App />));
