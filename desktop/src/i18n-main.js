// 앱 본체(메인 프로세스)가 직접 보여 주는 글 — 메뉴, 서버 주소 설정 화면(setup.html), 로그인 끝 화면(시스템 브라우저), 로컬 셸 이름.
// 화면(React)으로 보내는 오류 메시지는 한국어 그대로 보내고 화면이 번역한다(web/src/i18n-external.ts 에 키가 있다).
// 언어는 화면이 정해 알려 준다(app:set-lang → config.lang). 처음엔 OS 언어.
export const MAIN_LANGS = ['ko', 'en', 'ja', 'zh', 'es', 'de'];

const TEXT = {
  view: { ko: '보기', en: 'View', ja: '表示', zh: '视图', es: 'Ver', de: 'Ansicht' },
  help: { ko: '도움말', en: 'Help', ja: 'ヘルプ', zh: '帮助', es: 'Ayuda', de: 'Hilfe' },
  changeServer: { ko: '서버 주소 바꾸기…', en: 'Change server address…', ja: 'サーバーのアドレスを変更…', zh: '更改服务器地址…', es: 'Cambiar la dirección del servidor…', de: 'Serveradresse ändern…' },
  checkUpdates: { ko: '업데이트 확인', en: 'Check for updates', ja: 'アップデートを確認', zh: '检查更新', es: 'Buscar actualizaciones', de: 'Nach Updates suchen' },
  loginOk: { ko: '로그인되었습니다. Terminas로 돌아가 주세요.', en: 'You are signed in. Go back to Terminas.', ja: 'ログインしました。Terminas に戻ってください。', zh: '已登录。请返回 Terminas。', es: 'Has iniciado sesión. Vuelve a Terminas.', de: 'Sie sind angemeldet. Kehren Sie zu Terminas zurück.' },
  loginFail: { ko: '로그인하지 못했습니다.', en: 'Sign-in failed.', ja: 'ログインできませんでした。', zh: '登录失败。', es: 'No se pudo iniciar sesión.', de: 'Anmeldung fehlgeschlagen.' },
  closeWindow: { ko: '이 창은 닫아도 됩니다.', en: 'You can close this window.', ja: 'このウィンドウは閉じてかまいません。', zh: '可以关闭此窗口。', es: 'Puedes cerrar esta ventana.', de: 'Sie können dieses Fenster schließen.' },
  uiMissing: { ko: '화면 파일이 없습니다. 앱을 다시 설치해 주세요.', en: 'The app screen files are missing. Please reinstall the app.', ja: '画面ファイルがありません。アプリを再インストールしてください。', zh: '缺少界面文件。请重新安装应用。', es: 'Faltan los archivos de la interfaz. Vuelve a instalar la aplicación.', de: 'Die Oberflächendateien fehlen. Bitte installieren Sie die App neu.' },
  cmd: { ko: '명령 프롬프트', en: 'Command Prompt', ja: 'コマンド プロンプト', zh: '命令提示符', es: 'Símbolo del sistema', de: 'Eingabeaufforderung' },
  setupSub: { ko: "어느 Terminas 서버에 연결할지 골라 주세요.", en: "Choose which Terminas server to connect to.", ja: "接続する Terminas サーバーを選んでください。", zh: "请选择要连接的 Terminas 服务器。", es: "Elige a qué servidor de Terminas conectarte.", de: "Wählen Sie, mit welchem Terminas-Server Sie sich verbinden." },
  setupOfficial: { ko: "공식 서버", en: "Official server", ja: "公式サーバー", zh: "官方服务器", es: "Servidor oficial", de: "Offizieller Server" },
  setupCustom: { ko: "직접 운영하는 서버", en: "Self-hosted server", ja: "セルフホストのサーバー", zh: "自托管服务器", es: "Servidor propio", de: "Eigener Server" },
  setupCustomSub: { ko: "도메인이나 IP 주소 (예: shell.example.com, 192.168.0.10:5280)", en: "Domain or IP address (e.g. shell.example.com, 192.168.0.10:5280)", ja: "ドメインまたは IP アドレス（例: shell.example.com、192.168.0.10:5280）", zh: "域名或 IP 地址（例如：shell.example.com、192.168.0.10:5280）", es: "Dominio o dirección IP (p. ej., shell.example.com, 192.168.0.10:5280)", de: "Domain oder IP-Adresse (z. B. shell.example.com, 192.168.0.10:5280)" },
  setupHttpWarn: { ko: "암호화되지 않은 연결(http)입니다. 로그인 정보가 그대로 오가니 같은 내부망이나 VPN 안에서만 사용해 주세요.", en: "This is an unencrypted (http) connection. Sign-in details travel in plain text, so only use it inside your own network or VPN.", ja: "暗号化されていない接続（http）です。ログイン情報がそのまま流れるため、同じ内部ネットワークや VPN の中でのみ使ってください。", zh: "这是未加密的连接（http）。登录信息会以明文传输，请只在同一内网或 VPN 中使用。", es: "Es una conexión sin cifrar (http). Los datos de inicio de sesión viajan en texto plano, así que úsala solo dentro de tu red o VPN.", de: "Dies ist eine unverschlüsselte Verbindung (http). Anmeldedaten werden im Klartext übertragen – nutzen Sie sie nur im eigenen Netz oder VPN." },
  setupConnect: { ko: '연결', en: 'Connect', ja: '接続', zh: '连接', es: 'Conectar', de: 'Verbinden' },
  setupChecking: { ko: '확인하는 중…', en: 'Checking…', ja: '確認しています…', zh: '正在检查…', es: 'Comprobando…', de: 'Wird geprüft…' },
  setupFoot: { ko: "나중에 도움말 메뉴나 설정에서 바꿀 수 있습니다.", en: "You can change this later from the Help menu or Settings.", ja: "あとでヘルプメニューや設定から変更できます。", zh: "之后可以在\"帮助\"菜单或设置中更改。", es: "Puedes cambiarlo más tarde desde el menú Ayuda o la configuración.", de: "Sie können dies später im Hilfe-Menü oder in den Einstellungen ändern." },
  badUrl: { ko: "주소 형식이 올바르지 않습니다. 예: shell.example.com", en: "The address is not valid. Example: shell.example.com", ja: "アドレスの形式が正しくありません。例: shell.example.com", zh: "地址格式不正确。例如：shell.example.com", es: "La dirección no es válida. Ejemplo: shell.example.com", de: "Die Adresse ist ungültig. Beispiel: shell.example.com" },
  httpsOnly: { ko: "인터넷 주소는 https만 사용할 수 있습니다(내부망 IP·localhost는 http도 됩니다).", en: "Internet addresses must use https (http is allowed only for local-network IPs and localhost).", ja: "インターネット上のアドレスは https のみ使えます（内部ネットワークの IP と localhost は http も可）。", zh: "互联网地址只能使用 https（内网 IP 和 localhost 也可以用 http）。", es: "Las direcciones de Internet deben usar https (http solo se permite con IP de red local y localhost).", de: "Internetadressen müssen https verwenden (http nur für IPs im lokalen Netz und localhost)." },
  notTerminas: { ko: '해당 주소에서 Terminas 서버를 찾지 못했습니다.', en: 'No Terminas server was found at that address.', ja: 'そのアドレスで Terminas サーバーが見つかりませんでした。', zh: '在该地址未找到 Terminas 服务器。', es: 'No se encontró un servidor Terminas en esa dirección.', de: 'Unter dieser Adresse wurde kein Terminas-Server gefunden.' },
  // SFTP 로컬 창에서 실행 파일·스크립트·바로 가기 등을 열 때 묻는 창 (파일 이름은 따로 붙는다)
  openRiskyMessage: { ko: '이 파일은 열면 바로 실행될 수 있습니다.', en: 'This file may run as soon as it is opened.', ja: 'このファイルは開くとすぐに実行される可能性があります。', zh: '此文件打开后可能会立即运行。', es: 'Este archivo puede ejecutarse en cuanto se abra.', de: 'Diese Datei wird beim Öffnen möglicherweise sofort ausgeführt.' },
  openRiskyDetail: { ko: '프로그램·스크립트·바로 가기·매크로가 든 문서는 열면 이 PC에서 바로 실행됩니다. 믿을 수 있는 파일일 때만 열어 주세요.', en: 'Programs, scripts, shortcuts and documents with macros run on this PC as soon as they are opened. Only open it if you trust the file.', ja: 'プログラム、スクリプト、ショートカット、マクロを含む文書は、開くとこの PC ですぐに実行されます。信頼できるファイルの場合にのみ開いてください。', zh: '程序、脚本、快捷方式和含宏的文档一经打开就会在这台电脑上运行。请仅在信任该文件时打开。', es: 'Los programas, scripts, accesos directos y documentos con macros se ejecutan en este PC en cuanto se abren. Ábrelo solo si confías en el archivo.', de: 'Programme, Skripte, Verknüpfungen und Dokumente mit Makros werden beim Öffnen sofort auf diesem PC ausgeführt. Öffnen Sie die Datei nur, wenn Sie ihr vertrauen.' },
  openAnyway: { ko: '열기', en: 'Open', ja: '開く', zh: '打开', es: 'Abrir', de: 'Öffnen' },
  cancel: { ko: '취소', en: 'Cancel', ja: 'キャンセル', zh: '取消', es: 'Cancelar', de: 'Abbrechen' },
};

let lang = 'ko';

// 저장한 언어 → 없으면 OS 언어(app.getLocale(), 예: 'ko', 'en-US', 'zh-CN') → 없으면 영어
export function pickLang(saved, systemLocale) {
  if (MAIN_LANGS.includes(saved)) return saved;
  const base = String(systemLocale ?? '').toLowerCase().split('-')[0];
  return MAIN_LANGS.includes(base) ? base : 'en';
}

export function setMainLang(next) {
  if (MAIN_LANGS.includes(next)) lang = next;
}
export const mainLang = () => lang;

export function tm(id) {
  const entry = TEXT[id];
  return entry ? (entry[lang] ?? entry.ko) : id;
}

// 서버 주소 설정 화면에 넣을 글
export function setupTexts() {
  return { lang, sub: tm('setupSub'), connect: tm('setupConnect'), checking: tm('setupChecking'), foot: tm('setupFoot'), official: tm('setupOfficial'), custom: tm('setupCustom'), customSub: tm('setupCustomSub'), httpWarn: tm('setupHttpWarn') };
}
