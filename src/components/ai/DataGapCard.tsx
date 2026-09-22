import { Alert } from 'antd';

export default function DataGapCard({ gaps }: { gaps: string[] }) {
  if (!gaps.length) return null;
  return <Alert type="warning" showIcon message="数据缺口" description={gaps.join('；')} style={{ marginTop: 8, fontSize: 11.5 }} />;
}
