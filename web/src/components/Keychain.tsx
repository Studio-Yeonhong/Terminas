import { useEffect, useState } from 'react';
import { ChevronDown, Copy, KeyRound, Pencil, Plus, UserRound } from 'lucide-react';
import { errorMessage, type Identity, type SshKey } from '../api';
import { useStore } from '../store';
import { desktop } from '../desktop';
import { vaultApi } from '../vault';
import { Button, EmptyState, Field, Input, Select, SidePanel, Textarea, useMenu } from './ui';
import { t } from '../i18n';

type Panel = { kind: 'key'; key?: SshKey; mode?: 'import' | 'generate' } | { kind: 'identity'; identity?: Identity } | null;

export function KeychainView() {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState('');
  const { node: menuNode, open: openMenu } = useMenu();
  const { keys, identities } = s.items;

  useEffect(() => setPanel(null), [s.vault.id]);

  const q = query.trim().toLowerCase();
  const fk = keys.filter((k) => !q || [k.label, k.keyType, k.fingerprint].some((v) => v.toLowerCase().includes(q)));
  const fi = identities.filter((i) => !q || [i.label, i.username].some((v) => v.toLowerCase().includes(q)));
  const keyLabel = (id: string | null) => keys.find((k) => k.id === id)?.label;

  return (
    <>
      <div className="view">
        <div className="toolbar">
          {canEdit && (
            <div className="split-btn">
              <Button size="sm" onClick={() => setPanel({ kind: 'key', mode: 'import' })}>
                <Plus size={15} /> {t('새 키')}
              </Button>
              <button
                className="btn btn-soft btn-sm split-caret"
                aria-label={t('더 만들기')}
                onClick={(e) =>
                  openMenu({
                    anchor: e.currentTarget.getBoundingClientRect(),
                    items: [
                      { label: t('개인키 가져오기'), icon: <KeyRound size={14} />, onClick: () => setPanel({ kind: 'key', mode: 'import' }) },
                      { label: t('새 키 만들기'), icon: <Plus size={14} />, onClick: () => setPanel({ kind: 'key', mode: 'generate' }) },
                      { label: t('계정 프리셋(ID·비밀번호)'), icon: <UserRound size={14} />, onClick: () => setPanel({ kind: 'identity' }) },
                    ],
                  })
                }
              >
                <ChevronDown size={14} />
              </button>
            </div>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => setPanel({ kind: 'identity' })}>
              <UserRound size={15} /> {t('계정 프리셋')}
            </Button>
          )}
          <div className="toolbar-spacer" />
          <Input className="search-sm" placeholder={t('검색')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {!s.itemsLoading && keys.length === 0 && identities.length === 0 ? (
          <EmptyState icon={<KeyRound size={22} />} title={t('자격증명 추가')} text={t('SSH 키와 계정 프리셋(사용자 이름 + 비밀번호/키)을 저장해 두고 여러 호스트에서 함께 사용해 주세요.')}>
            {canEdit && (
              <div className="empty-actions">
                <Button variant="primary" onClick={() => setPanel({ kind: 'key', mode: 'import' })}>
                  {t('개인키 가져오기')}
                </Button>
                <Button onClick={() => setPanel({ kind: 'key', mode: 'generate' })}>{t('새 키 만들기')}</Button>
              </div>
            )}
          </EmptyState>
        ) : (
          <div className="view-content">
            <section>
              <h2 className="section-title">{t('키')}</h2>
              {fk.length === 0 ? (
                <p className="muted small">{t('키가 없습니다.')}</p>
              ) : (
                <div className={`cards ${s.prefs.view}`}>
                  {fk.map((k) => (
                    <div key={k.id} className={`item-card ${panel?.kind === 'key' && panel.key?.id === k.id ? 'selected' : ''}`} role="button" tabIndex={0} onClick={() => setPanel({ kind: 'key', key: k })}>
                      <div className="item-icon key">
                        <KeyRound size={17} />
                      </div>
                      <div className="item-text">
                        <div className="item-title">{k.label}</div>
                        <div className="item-sub">{k.keyType.replace(/^ssh-/, '')}</div>
                      </div>
                      <span className="card-action static">
                        <Pencil size={14} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section>
              <h2 className="section-title">{t('계정 프리셋')}</h2>
              {fi.length === 0 ? (
                <p className="muted small">{t('계정 프리셋이 없습니다. 여러 호스트에 같은 ID·비밀번호를 사용한다면 한 번 저장해 두고 골라 사용해 주세요.')}</p>
              ) : (
                <div className={`cards ${s.prefs.view}`}>
                  {fi.map((i) => (
                    <div key={i.id} className={`item-card ${panel?.kind === 'identity' && panel.identity?.id === i.id ? 'selected' : ''}`} role="button" tabIndex={0} onClick={() => setPanel({ kind: 'identity', identity: i })}>
                      <div className="item-icon identity">
                        <UserRound size={17} />
                      </div>
                      <div className="item-text">
                        <div className="item-title">{i.label}</div>
                        <div className="item-sub">
                          {i.username}
                          {i.hasPassword ? ` · ${t('비밀번호')}` : ''}
                          {i.keyId ? ` · ${keyLabel(i.keyId) ?? t('키')}` : ''}
                        </div>
                      </div>
                      <span className="card-action static">
                        <Pencil size={14} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      {panel?.kind === 'key' && <KeyEditor key={panel.key?.id ?? `new-${panel.mode}`} sshKey={panel.key} initialMode={panel.mode ?? 'import'} onClose={() => setPanel(null)} />}
      {panel?.kind === 'identity' && <IdentityEditor key={panel.identity?.id ?? 'new'} identity={panel.identity} onClose={() => setPanel(null)} />}
      {menuNode}
    </>
  );
}

function KeyEditor({ sshKey, initialMode, onClose }: { sshKey?: SshKey; initialMode: 'import' | 'generate'; onClose: () => void }) {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const [mode, setMode] = useState(initialMode);
  const [label, setLabel] = useState(sshKey?.label ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [keyType, setKeyType] = useState<'ed25519' | 'ecdsa' | 'rsa'>('ed25519');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (sshKey) {
        await vaultApi.renameKey(sshKey.id, label);
      } else {
        await vaultApi.createKey(s.vault.id, mode === 'generate' ? { label, generate: keyType, passphrase: passphrase || null } : { label, privateKey, passphrase: passphrase || null });
      }
      await s.reloadItems();
      s.toast(sshKey ? t('저장했습니다') : t('키를 저장했습니다'), 'success');
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!sshKey) return;
    const ok = await s.confirm({ title: t('키 삭제'), message: t('"{name}" 키를 지웁니다. 이 키를 사용하던 호스트·계정 프리셋에서는 키 연결이 해제됩니다.', { name: sshKey.label }), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    try {
      await vaultApi.deleteKey(sshKey.id);
      await s.reloadItems();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.toast(t('복사했습니다'), 'success');
    } catch {
      s.toast(t('클립보드에 복사하지 못했습니다'), 'error');
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 32 * 1024) return s.toast(t('키 파일이 너무 큽니다'), 'error');
    setPrivateKey(await file.text());
    if (!label) setLabel(file.name.replace(/\.(pem|key)$/i, ''));
  };

  return (
    <SidePanel
      title={sshKey ? t('키') : mode === 'generate' ? t('새 키 만들기') : t('개인키 가져오기')}
      onClose={onClose}
      footer={
        canEdit && (
          <>
            {sshKey && (
              <Button variant="danger" onClick={() => void remove()}>
                {t('삭제')}
              </Button>
            )}
            <Button variant="primary" loading={busy} onClick={() => void save()} disabled={!label.trim() || (!sshKey && mode === 'import' && !privateKey.trim())}>
              {sshKey ? t('저장') : mode === 'generate' ? t('만들기') : t('저장')}
            </Button>
          </>
        )
      }
    >
      {!sshKey && (
        <div className="seg wide">
          <button className={mode === 'import' ? 'on' : ''} onClick={() => setMode('import')}>
            {t('가져오기')}
          </button>
          <button className={mode === 'generate' ? 'on' : ''} onClick={() => setMode('generate')}>
            {t('새로 만들기')}
          </button>
        </div>
      )}
      <div className="panel-section">
        <h4>{t('일반')}</h4>
        <Input placeholder={t('이름(예: 배포용 키)')} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canEdit} autoFocus />
      </div>

      {!sshKey && mode === 'import' && (
        <div className="panel-section">
          <h4>{t('개인키')}</h4>
          <Textarea className="mono" rows={9} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} spellCheck={false} />
          <label className="file-pick">
            {t('파일에서 불러오기')}
            <input type="file" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <Input type="password" placeholder={t('키 암호(있으면)')} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
          <p className="panel-hint">{t('개인키는 서버에서 암호화해 보관하며 저장한 뒤에는 누구도 다시 볼 수 없습니다(공개키만 보입니다).')}</p>
        </div>
      )}

      {!sshKey && mode === 'generate' && (
        <div className="panel-section">
          <h4>{t('종류')}</h4>
          <Select value={keyType} onChange={(e) => setKeyType(e.target.value as typeof keyType)}>
            <option value="ed25519">{t('Ed25519(추천)')}</option>
            {desktop && <option value="ecdsa">ECDSA P-256</option>}
            {desktop && <option value="rsa">RSA 4096</option>}
          </Select>
          <Input type="password" placeholder={t('키 암호(선택)')} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
          <p className="panel-hint">{t('만든 뒤 나오는 공개키를 서버의 ~/.ssh/authorized_keys에 넣으면 됩니다.')}</p>
        </div>
      )}

      {sshKey && (
        <div className="panel-section">
          <h4>{t('공개키')}</h4>
          <Textarea className="mono" rows={5} readOnly value={sshKey.publicKey} onFocus={(e) => e.currentTarget.select()} />
          <div className="row-actions">
            <Button size="sm" onClick={() => void copy(sshKey.publicKey)}>
              <Copy size={14} /> {t('공개키 복사')}
            </Button>
          </div>
          <Field label={t('지문')}>
            <code className="fingerprint">{sshKey.fingerprint}</code>
          </Field>
          <Field label={t('종류')}>
            <span>
              {sshKey.keyType}
              {sshKey.hasPassphrase ? ` · ${t('암호 있음')}` : ''}
            </span>
          </Field>
        </div>
      )}
    </SidePanel>
  );
}

function IdentityEditor({ identity, onClose }: { identity?: Identity; onClose: () => void }) {
  const s = useStore();
  const canEdit = s.vault.perm === 'edit';
  const [label, setLabel] = useState(identity?.label ?? '');
  const [username, setUsername] = useState(identity?.username ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [keyId, setKeyId] = useState<string | null>(identity?.keyId ?? null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { label, username, keyId };
      if (password) payload.password = password;
      else if (clearPassword) payload.password = null;
      if (identity) await vaultApi.updateIdentity(identity.id, payload);
      else await vaultApi.createIdentity(s.vault.id, payload);
      await s.reloadItems();
      s.toast(t('저장했습니다'), 'success');
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!identity) return;
    const ok = await s.confirm({ title: t('계정 프리셋 삭제'), message: t('"{name}"을(를) 지웁니다. 이것을 사용하던 호스트는 자격증명이 비게 됩니다.', { name: identity.label }), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    try {
      await vaultApi.deleteIdentity(identity.id);
      await s.reloadItems();
      onClose();
    } catch (err) {
      s.toast(errorMessage(err), 'error');
    }
  };

  return (
    <SidePanel
      title={identity ? t('계정 프리셋') : t('새 계정 프리셋')}
      onClose={onClose}
      footer={
        canEdit && (
          <>
            {identity && (
              <Button variant="danger" onClick={() => void remove()}>
                {t('삭제')}
              </Button>
            )}
            <Button variant="primary" loading={busy} onClick={() => void save()} disabled={!label.trim() || !username.trim()}>
              {t('저장')}
            </Button>
          </>
        )
      }
    >
      <div className="panel-section">
        <h4>{t('일반')}</h4>
        <Input placeholder={t('이름(예: 운영 root)')} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canEdit} autoFocus />
      </div>
      <div className="panel-section">
        <h4>{t('자격증명')}</h4>
        <Input placeholder={t('사용자 이름')} value={username} onChange={(e) => setUsername(e.target.value)} disabled={!canEdit} autoComplete="off" />
        {canEdit && (
          <Input
            type="password"
            placeholder={identity?.hasPassword && !clearPassword ? t('저장된 비밀번호 있음 — 바꾸려면 입력') : t('비밀번호(선택)')}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setClearPassword(false);
            }}
            autoComplete="new-password"
          />
        )}
        {canEdit && identity?.hasPassword && !password && (
          <button type="button" className="link-btn" onClick={() => setClearPassword(!clearPassword)}>
            {clearPassword ? t('저장된 비밀번호 지우기 취소') : t('저장된 비밀번호 지우기')}
          </button>
        )}
        <Field label={t('SSH 키')}>
          <Select value={keyId ?? ''} onChange={(e) => setKeyId(e.target.value || null)} disabled={!canEdit}>
            <option value="">{t('키 없음')}</option>
            {s.items.keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({k.keyType})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {!canEdit && <p className="panel-hint">{t('보기 전용 볼트라 수정할 수 없습니다.')}</p>}
    </SidePanel>
  );
}
