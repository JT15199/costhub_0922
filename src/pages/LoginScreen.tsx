import { useState, useEffect } from 'react';
import { Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined, KeyOutlined, SafetyOutlined } from '@ant-design/icons';
import defaultLogo from '../assets/costhub-logo.png';

interface Props {
  onUnlock: () => void;      // 密码正确：解锁数据
  onEnterRestricted: () => void; // 密码错误：进入受限模式（不显示数据）
}

export default function LoginScreen({ onUnlock, onEnterRestricted }: Props) {
  const [username, setUsername] = useState('');
  const [pwd, setPwd] = useState('');
  const [checking, setChecking] = useState(false);
  // 首次使用提示（改过密码后不再显示）
  const [firstUse, setFirstUse] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const { isFirstUse, getUsername } = await import('../db');
        setFirstUse(await isFirstUse());
        setUsername(await getUsername());
      } catch { }
    })();
  }, []);

  const submit = async (isCorrect: boolean) => {
    if (isCorrect) {
      message.success('验证通过，已解锁数据');
      onUnlock();
    } else {
      message.warning('用户名或密码不正确，将以受限模式进入（不显示数据）');
      onEnterRestricted();
    }
  };

  const handleSubmit = async () => {
    if (!username.trim()) { message.warning('请输入用户名'); return; }
    if (!pwd.trim()) { message.warning('请输入密码'); return; }
    setChecking(true);
    try {
      const { verifyPassword, getUsername } = await import('../db');
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
    <div style={{
      flex: 1, width: '100%', minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // 精致现代：暖白画布 + 双色柔光晕染（Indigo/琥珀微光），摒弃深蓝硬朗风
      background: 'linear-gradient(155deg, #F6F5F4 0%, #F1F0FE 38%, #F6F5F4 62%, #FDF6EC 100%)',
      position: 'relative', overflow: 'hidden',
    }}>
      {/* 柔光氛围光斑 */}
      <div style={{
        position: 'absolute', width: 420, height: 420, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(99,102,241,0.14) 0%, transparent 65%)',
        top: '-120px', right: '-80px', pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', width: 360, height: 360, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(245,165,36,0.10) 0%, transparent 65%)',
        bottom: '-100px', left: '-60px', pointerEvents: 'none',
      }} />

      {/* 登录卡片：白底毛玻璃 + 柔和双层阴影 + 顶部品牌色细条 */}
      <div style={{
        width: 384, padding: '44px 38px 36px', borderRadius: 22,
        background: 'rgba(255,255,255,0.86)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        boxShadow: '0 2px 4px rgba(32,31,29,0.05), 0 20px 48px rgba(32,31,29,0.10)',
        border: '1px solid rgba(32,31,29,0.05)',
        position: 'relative',
        animation: 'loginCardIn 420ms cubic-bezier(0.23, 1, 0.32, 1) both',
      }}>
        {/* 顶部品牌色细条（签名元素） */}
        <div style={{
          position: 'absolute', top: 0, left: '12%', right: '12%', height: 3,
          background: 'linear-gradient(90deg, transparent, #6366F1 30%, #6366F1 70%, transparent)',
          borderRadius: '0 0 4px 4px', opacity: 0.85,
        }} />
        <style>{`
          @keyframes loginCardIn {
            from { opacity: 0; transform: translateY(14px) scale(0.985); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          .login-input .ant-input,
          .login-input .ant-input-password {
            border-radius: 10px !important;
            transition: border-color 180ms cubic-bezier(0.32,0.72,0,1), box-shadow 180ms cubic-bezier(0.32,0.72,0,1) !important;
          }
          /* 输入框内文字行高撑满格子 → 光标（caret）与输入框高度匹配 */
          .login-input .ant-input,
          .login-input .ant-input-password .ant-input,
          .login-input .ant-input-affix-wrapper .ant-input {
            font-size: 15px;
            line-height: 40px !important;
            height: 40px !important;
            caret-color: #4F46E5;
          }
          .login-input .ant-input-password .ant-input {
            line-height: 40px !important;
          }
          .login-input .ant-input:focus,
          .login-input .ant-input-password:focus,
          .login-input .ant-input-affix-wrapper-focused {
            border-color: #6366F1 !important;
            box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important;
          }
          /* 登录按钮：内联渐变 + 白色文字，需压过全局 .ant-btn-primary 的 background-image 覆盖 */
          .login-btn.ant-btn-primary {
            background-image: none !important;
            background: linear-gradient(180deg, #6366F1 0%, #4F46E5 100%) !important;
            color: #FFFFFF !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
          }
          .login-btn.ant-btn-primary:hover {
            background-image: none !important;
            background: linear-gradient(180deg, #6D70F5 0%, #5658E8 100%) !important;
            color: #FFFFFF !important;
          }
          .login-btn.ant-btn-primary:active {
            background-image: none !important;
            background: linear-gradient(180deg, #585BE8 0%, #4338CA 100%) !important;
            color: #FFFFFF !important;
          }
        `}</style>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 68, height: 68, margin: '0 auto 14px', borderRadius: 20,
              overflow: 'hidden',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(135deg, #EEF0FF 0%, #F8F7FF 100%)',
              boxShadow: '0 8px 24px rgba(99,102,241,0.18), inset 0 0 0 1px rgba(99,102,241,0.10)',
              transition: 'transform 200ms cubic-bezier(0.32,0.72,0,1)',
            }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'none')}
          >
            <img src={defaultLogo} alt="CostHub" style={{ width: '88%', height: '88%', objectFit: 'contain' }} />
          </div>
          <div style={{ fontSize: 23, fontWeight: 800, color: '#201F1D', letterSpacing: '-0.02em' }}>CostHub</div>
          <div style={{ fontSize: 12, color: '#8A857E', marginTop: 3, letterSpacing: '0.02em' }}>成本管理平台 · 数据受密码保护</div>
        </div>

        {/* 用户名 + 密码输入 */}
        <div className="login-input" style={{ marginBottom: 14 }}>
          <Input
            size="large"
            prefix={<UserOutlined style={{ color: '#A8A39B' }} />}
            placeholder="用户名"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
          />
        </div>
        <div className="login-input" style={{ marginBottom: 22 }}>
          <Input.Password
            size="large"
            prefix={<LockOutlined style={{ color: '#A8A39B' }} />}
            placeholder="请输入访问密码"
            value={pwd}
            onChange={e => setPwd(e.target.value)}
            onPressEnter={handleSubmit}
          />
        </div>

        <Button
          type="primary" size="large" block loading={checking}
          className="login-btn"
          onClick={handleSubmit}
          style={{
            borderRadius: 10, height: 44, fontWeight: 600, fontSize: 14.5, letterSpacing: '0.02em',
            background: 'linear-gradient(180deg, #6366F1 0%, #4F46E5 100%)',
            border: 'none', boxShadow: '0 4px 16px rgba(99,102,241,0.32)',
            transition: 'transform 160ms cubic-bezier(0.32,0.72,0,1), box-shadow 160ms ease-out, filter 160ms ease-out',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 22px rgba(99,102,241,0.40)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(99,102,241,0.32)'; }}
          onMouseDown={e => { e.currentTarget.style.transform = 'translateY(0) scale(0.985)'; e.currentTarget.style.filter = 'brightness(0.96)'; }}
          onMouseUp={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.filter = 'none'; }}
        >
          进入 CostHub
        </Button>

        <div style={{
          marginTop: 20, padding: '11px 14px', background: 'rgba(99,102,241,0.05)',
          borderRadius: 10, fontSize: 11.5, color: '#6E6A64', lineHeight: 1.7,
          border: '1px solid rgba(99,102,241,0.08)',
        }}>
          {firstUse ? (
            <>
              <KeyOutlined style={{ marginRight: 6, color: '#F5A524' }} />
              首次使用，默认用户名 <b style={{ color: '#4F46E5' }}>admin</b>，初始密码 <b style={{ color: '#4F46E5' }}>666666</b>。登录后可在「系统设置」中修改。
            </>
          ) : (
            <>
              <SafetyOutlined style={{ marginRight: 6, color: '#6366F1' }} />
              密码用于保护本地成本数据，输入错误仍可进入，但所有数据将被隐藏。
            </>
          )}
        </div>
      </div>
    </div>
  );
}
