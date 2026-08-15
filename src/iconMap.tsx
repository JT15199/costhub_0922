// CostHub 统一图标映射：把 emoji 统一替换为 AntD 简笔画图标
// 同功能图标保持一致，集中管理，避免各处不一致
import {
  SearchOutlined, RobotOutlined, CheckCircleOutlined, CloseCircleOutlined,
  WarningOutlined, BulbOutlined, BarChartOutlined,
  LineChartOutlined, ToolOutlined, SettingOutlined,
  BookOutlined, CalendarOutlined, FileTextOutlined, ThunderboltOutlined,
  ShopOutlined, FolderOutlined, AppstoreOutlined,
  LinkOutlined, ClockCircleOutlined,
  DollarOutlined, TrophyOutlined, TagOutlined, RocketOutlined,
  AimOutlined, AuditOutlined, DatabaseOutlined, ExperimentOutlined,
  FundOutlined, HighlightOutlined, InboxOutlined,
  KeyOutlined, LaptopOutlined, MessageOutlined,
  NotificationOutlined, PaperClipOutlined,
  PlusOutlined, ProfileOutlined, QuestionCircleOutlined,
  ReadOutlined, ReloadOutlined, SafetyOutlined, SaveOutlined,
  ScheduleOutlined, SolutionOutlined, StarOutlined, SyncOutlined,
  UploadOutlined, DownloadOutlined, EyeOutlined, EyeInvisibleOutlined,
  GlobalOutlined, LockOutlined, UnlockOutlined, FireOutlined,
} from '@ant-design/icons';
import React from 'react';

// emoji → AntD 图标组件 映射表（同功能统一）
export const EMOJI_ICONS: Record<string, React.ReactNode> = {
  // 状态类
  '✅': <CheckCircleOutlined style={{ color: '#16A34A' }} />,
  '❌': <CloseCircleOutlined style={{ color: '#DC2626' }} />,
  '⚠️': <WarningOutlined style={{ color: '#D97706' }} />,
  '💡': <BulbOutlined style={{ color: '#D97706' }} />,
  '⏳': <ClockCircleOutlined />,
  '🔍': <SearchOutlined />,
  '🔧': <ToolOutlined />,
  '⚙️': <SettingOutlined />,
  '🧠': <RobotOutlined />,
  '🤖': <RobotOutlined />,
  '📊': <BarChartOutlined />,
  '📈': <LineChartOutlined />,
  '📁': <FolderOutlined />,
  '📄': <FileTextOutlined />,
  '📅': <CalendarOutlined />,
  '📝': <EditOutlined />,
  '📔': <BookOutlined />,
  '📌': <PushpinOutlined />,
  '📎': <PaperClipOutlined />,
  '📚': <ReadOutlined />,
  '📖': <ReadOutlined />,
  '🧩': <AppstoreOutlined />,
  '🏪': <ShopOutlined />,
  '🏭': <BuildOutlined />,
  '🏷️': <TagOutlined />,
  '🏆': <TrophyOutlined />,
  '💰': <DollarOutlined />,
  '💎': <FundOutlined />,
  '🎯': <AimOutlined />,
  '🚀': <RocketOutlined />,
  '🔥': <FireOutlined />,
  '⭐': <StarOutlined />,
  '🌟': <StarOutlined />,
  '🌍': <GlobalOutlined />,
  '🔒': <LockOutlined />,
  '🔓': <UnlockOutlined />,
  '🔗': <LinkOutlined />,
  '🔄': <SyncOutlined />,
  '🗑️': <DeleteOutlined />,
  '✏️': <EditOutlined />,
  '➕': <PlusOutlined />,
  '📥': <DownloadOutlined />,
  '📤': <UploadOutlined />,
  '👁️': <EyeOutlined />,
  '🚫': <EyeInvisibleOutlined />,
  '🛡️': <SafetyOutlined />,
  '🗂️': <InboxOutlined />,
  '📋': <ProfileOutlined />,
  '⏰': <ScheduleOutlined />,
  '📉': <LineChartOutlined />,
  '🧾': <FileTextOutlined />,
  '🖥️': <LaptopOutlined />,
  '📱': <LaptopOutlined />,
  '🌐': <GlobalOutlined />,
  '🛠️': <ToolOutlined />,
  '🧰': <ToolOutlined />,
  '🎨': <HighlightOutlined />,
  '🧪': <ExperimentOutlined />,
  '🗄️': <DatabaseOutlined />,
  '📦': <InboxOutlined />,
  '🎓': <SolutionOutlined />,
  '💬': <MessageOutlined />,
  '📢': <NotificationOutlined />,
  '🧭': <CompassOutlined />,
  '🖇️': <PaperClipOutlined />,
  '🔑': <KeyOutlined />,
  '❓': <QuestionCircleOutlined />,
  '💾': <SaveOutlined />,
  '🗓️': <CalendarOutlined />,
  '📑': <FileTextOutlined />,
  '♻️': <ReloadOutlined />,
  '⚡': <ThunderboltOutlined />,
  '🧲': <AimOutlined />,
  '🪜': <AuditOutlined />,
};

// 工具函数：把字符串里的 emoji 替换为图标
export function replaceEmoji(text: string): React.ReactNode {
  // 按映射表替换（从长到短避免部分匹配）
  const keys = Object.keys(EMOJI_ICONS).sort((a, b) => b.length - a.length);
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let matched = false;
  for (const key of keys) {
    const idx = remaining.indexOf(key);
    if (idx !== -1) {
      matched = true;
      if (idx > 0) parts.push(remaining.slice(0, idx));
      parts.push(<React.Fragment key={key}>{EMOJI_ICONS[key]}</React.Fragment>);
      remaining = remaining.slice(idx + key.length);
      // 重新开始匹配剩余部分
      const rest = replaceEmoji(remaining);
      if (rest) parts.push(rest);
      remaining = '';
      break;
    }
  }
  if (!matched && remaining) parts.push(remaining);
  return <>{parts}</>;
}

// 补充导入（上面引用了但未列出）
import { EditOutlined, PushpinOutlined, BuildOutlined, DeleteOutlined, CompassOutlined, CloudOutlined, StopOutlined } from '@ant-design/icons';

// ===== 补充映射（UI 常用） =====
EMOJI_ICONS['🎯'] = <AimOutlined />;
EMOJI_ICONS['🤖'] = <RobotOutlined />;
EMOJI_ICONS['📈'] = <FundOutlined />;
EMOJI_ICONS['🛡'] = <SafetyOutlined />;
EMOJI_ICONS['☁'] = <CloudOutlined />;
EMOJI_ICONS['💡'] = <BulbOutlined />;
EMOJI_ICONS['♻'] = <ReloadOutlined />;
EMOJI_ICONS['🧠'] = <ExperimentOutlined />;
EMOJI_ICONS['🕐'] = <ClockCircleOutlined />;
EMOJI_ICONS['💰'] = <DollarOutlined />;
EMOJI_ICONS['📦'] = <AppstoreOutlined />;
EMOJI_ICONS['❓'] = <QuestionCircleOutlined />;
EMOJI_ICONS['✗'] = <CloseCircleOutlined />;
EMOJI_ICONS['📌'] = <PushpinOutlined />;
EMOJI_ICONS['🏭'] = <ShopOutlined />;
EMOJI_ICONS['📋'] = <ProfileOutlined />;
EMOJI_ICONS['✅'] = <CheckCircleOutlined />;
EMOJI_ICONS['❌'] = <CloseCircleOutlined />;
EMOJI_ICONS['💬'] = <MessageOutlined />;
EMOJI_ICONS['⚡'] = <ThunderboltOutlined />;
EMOJI_ICONS['🔒'] = <LockOutlined />;
EMOJI_ICONS['📊'] = <BarChartOutlined />;
EMOJI_ICONS['📄'] = <FileTextOutlined />;
EMOJI_ICONS['📝'] = <EditOutlined />;
EMOJI_ICONS['📔'] = <BookOutlined />;
EMOJI_ICONS['📅'] = <CalendarOutlined />;
EMOJI_ICONS['🔍'] = <SearchOutlined />;
EMOJI_ICONS['🚫'] = <StopOutlined />;
EMOJI_ICONS['🗑'] = <DeleteOutlined />;
EMOJI_ICONS['🔥'] = <FireOutlined />;

// ===== EmojiIcon 组件：JSX 中直接替换 emoji 为 AntD 图标 =====
export function EmojiIcon({ e, style }: { e: string; style?: React.CSSProperties }) {
  const icon = EMOJI_ICONS[e] || EMOJI_ICONS[e + '️'];
  return icon ? <span style={{ display: 'inline-flex', alignItems: 'center', ...style }}>{icon}</span> : <span style={style}>{e}</span>;
}
