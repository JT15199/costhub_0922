import { Component } from 'react';
import { Button } from 'antd';

// 全局错误边界（v2.3.19）：任何页面渲染崩溃 → 显示错误信息而不是白屏
// 用户可复制错误文本反馈，或点重试恢复
interface State { hasError: boolean; message: string; }

export default class ErrorBoundary extends Component<{ children: any; label?: string }, State> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(err: any) {
    return { hasError: true, message: String(err?.message || err) };
  }

  componentDidCatch(err: any, info: any) {
    console.error('[ErrorBoundary]', this.props.label || '', err, info?.componentStack || '');
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#DC2626', marginBottom: 10 }}>页面渲染出错（已拦截，不再是白屏）</div>
          <div style={{ fontSize: 12.5, color: '#6B7280', marginBottom: 16, wordBreak: 'break-all', maxWidth: 640, margin: '0 auto 16px', lineHeight: 1.7 }}>
            {this.props.label ? <div style={{ marginBottom: 6 }}><b>{this.props.label}</b></div> : null}
            <code>{this.state.message}</code>
          </div>
          <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: 16 }}>
            请把上方错误信息复制反馈给开发（或按 F12 打开控制台查看完整报错）
          </div>
          <Button type="primary" onClick={this.handleReset}>重试</Button>
        </div>
      );
    }
    return this.props.children;
  }
}