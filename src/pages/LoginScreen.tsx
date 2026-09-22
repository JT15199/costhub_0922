import { useState, useEffect } from 'react';
import { Input, Button, message, Alert } from 'antd';
import { UserOutlined, LockOutlined, KeyOutlined, SafetyOutlined, DatabaseOutlined, FileSearchOutlined, CloudOutlined } from '@ant-design/icons';
import defaultLogo from '../assets/costhub-logo.png';

interface Props {
  onUnlock: () => void;      // 密码正确：解锁数据
  onEnterRestricted: () => void; // 密码错误：进入受限模式（不显示数据）
}

export default function LoginScreen({ onUnlock, onEnterRestricted }: Props) {
  const [username, setUsername] = useState('admin');
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState('');
  const [pwd, setPwd] = useState('');
  const [checking, setChecking] = useState(false);
  // 首次使用提示（改过密码后不再显示）
  const [firstUse, setFirstUse] = useState(false);
  const [entering, setEntering] = useState(false);

  const initialize = async () => {
    setInitializing(true);
    setInitError('');
    try {
      const { ensureAuthPassword, isFirstUse, getUsername } = await import('../db');
      await ensureAuthPassword();
      setFirstUse(await isFirstUse());
      setUsername(await getUsername());
    } catch (error) {
      setInitError(error instanceof Error ? error.message : String(error));
    } finally { setInitializing(false); }
  };
  useEffect(() => { void initialize(); }, []);

  const submit = async (isCorrect: boolean) => {
    if (isCorrect) {
      message.success('验证通过，正在进入 CostHub');
      setEntering(true);
      const reduced = document.documentElement.dataset.lowfx === 'on'
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) await new Promise(resolve => window.setTimeout(resolve, 680));
      onUnlock();
    } else {
      message.warning('用户名或密码不正确，将以受限模式进入（不显示数据）');
      onEnterRestricted();
    }
  };

  const handleSubmit = async () => {
    if (initializing || initError) return;
    if (!username.trim()) { message.warning('请输入用户名'); return; }
    if (!pwd.trim()) { message.warning('请输入密码'); return; }
    setChecking(true);
    try {
      const { ensureAuthPassword, verifyPassword, getUsername } = await import('../db');
      await ensureAuthPassword();
      const savedName = await getUsername();
      const ok = username.trim() === savedName && (await verifyPassword(pwd));
      await submit(ok);
    } catch (e: any) {
      message.error(`验证失败：${e?.message || e}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={`login-screen ${entering ? 'is-entering' : ''}`}>
      <div className="login-light login-light-a" />
      <div className="login-light login-light-b" />
      <div className="login-shell">
        <section className="login-brand-pane" aria-label="CostHub 产品信息">
          <div className="login-brand-lockup">
            <div className="login-logo-hitarea">
              <img className="login-logo-image" src={defaultLogo} alt="CostHub" />
            </div>
            <div className="login-brand-name">CostHub</div>
            <div className="login-brand-subtitle">显示器成本管理平台</div>
          </div>

          <div className="login-trust-list">
            <div className="login-trust-item"><DatabaseOutlined /><span>本地数据库</span><small>数据留在本机</small></div>
            <div className="login-trust-item"><FileSearchOutlined /><span>报价可追溯</span><small>版本与变动有记录</small></div>
            <div className="login-trust-item"><CloudOutlined /><span>云端需审批</span><small>敏感信息先审查</small></div>
          </div>
        </section>

        <section className="login-form-pane" aria-label="登录">
          <div className="login-form-heading">
            <h1>欢迎回来</h1>
            <p>继续管理你的成本决策</p>
          </div>

          <label className="login-field">
            <span className="login-field-label">用户名</span>
            <Input
              size="large"
              prefix={<UserOutlined />}
              placeholder="请输入用户名"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              data-testid="login-username"
            />
          </label>
          <label className="login-field">
            <span className="login-field-label">密码</span>
            <Input.Password
              size="large"
              prefix={<LockOutlined />}
              placeholder="请输入访问密码"
              value={pwd}
              onChange={e => setPwd(e.target.value)}
              onPressEnter={handleSubmit}
              autoComplete="current-password"
              data-testid="login-password"
            />
          </label>

          <Button type="primary" size="large" block disabled={!!initError} loading={checking || initializing} className="login-btn" onClick={handleSubmit} data-testid="login-submit">
            {initializing ? '正在准备本地数据库…' : '登录'}
          </Button>

          {initError && <Alert type="error" showIcon title="数据库初始化未完成" description={initError} action={<Button onClick={initialize}>重试</Button>} style={{marginTop:12}} />}

          <div className="login-security-row">
            <button type="button" onClick={() => message.info('成本数据默认仅在本机处理；任何云端分析都需先经过脱敏与审批。')}>
              <SafetyOutlined /> 数据安全说明
            </button>
            <span><LockOutlined /> 数据仅在本机处理</span>
          </div>

          <div className="login-note">
            {firstUse ? (
              <>
                <KeyOutlined /> 首次使用，默认用户名 <b>admin</b>，初始密码 <b>666666</b>。登录后可在系统设置中修改。
              </>
            ) : (
              <>
                <SafetyOutlined /> 密码用于保护本地成本数据，输入错误仍可进入，但所有数据将被隐藏。
              </>
            )}
          </div>
        </section>
      </div>

      <div className="login-transition" aria-live="polite">
        <span className="login-transition-mark"><SafetyOutlined /></span>
        <strong>正在进入 CostHub</strong>
        <small>本地数据已验证</small>
      </div>
    </div>
  );
}
