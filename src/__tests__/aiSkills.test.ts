import { describe, expect, it } from 'vitest';
import { detectSkills, getTenderSkill } from '../aiSkills';

describe('招标工作台 AI 技能', () => {
  it('招标问题命中专用技能并强调谈判锚点边界', () => {
    const skill = getTenderSkill();
    expect(skill).toBeDefined();
    expect(detectSkills('帮我做多家供应商报价比价并生成议价清单')).toContain(skill);
    expect(skill?.guide).toContain('谈判锚点');
    expect(skill?.guide).toContain('不得覆盖项目 BOM');
  });
});
