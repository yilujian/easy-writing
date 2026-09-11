// 请求响应参数（不包含data）
// 请求响应参数（包含data）
// 分页响应参数
export interface ResPage<T> {
  list: T[];
  pagination: {
    total: number;
    page: number;
    size: number;
  }
}

// 分页请求参数
export interface ReqPage {
  page: number;
  size: number;
}

// 文件上传模块
/**
 * 定义书籍数据模型 (对应后端的 Entity)
 */
export interface Book {
  id: number;
  title: string;
  intro?: string;
  coverUrl?: string;
  category?: string;
  tags?: string[];
  platform?: string;
  perspective?: string;
  audience?: string;
  groupId?: string | null;
  status?: number; // 0-连载 1-完结
  visibility?: number; // 0-私有 1-公开
  wordCount?: number;
  textWordCount?: number | null;

  authorId?: string;
  globalInstruction?: Record<string, unknown> | string | null;
  createTime?: string;
  updateTime?: string;
  /** 旧云端镜像标记：merged = 从云端备份收编下来的本地副本（取值同 LocalMergeStatus） */
  mergeStatus?: 'local' | 'merged' | 'ignored';
}

export interface BookGroup {
  id: number;
  title: string;
  sortNo: number;
  authorId?: string;
  createTime?: string;
  updateTime?: string;
}

export interface WorldSetting {
  id: number;
  bookId: string;
  groupId?: string | number | null;
  name: string;
  type: number; // 0-地理位置 1-势力宗门 2-功法技能 3-物品道具 4-等级体系 5-其他
  detail?: string;
  imageUrl?: string;
  relatedChapterIds?: string[];
  sortNo?: number;
}

export interface WorldSettingGroup {
  id: number;
  bookId: string;
  title: string;
  sortNo: number;
}

export interface WorldSettingTreeFolder {
  id: string | number;
  title: string;
  isVirtual?: boolean;
  children: WorldSetting[];
}


export interface Character {
  id: number;
  bookId: string;
  groupId?: string | number | null;
  name: string;
  role: number; // 0-主角 1-主要配角 2-反派 3-路人
  gender: number; // 0-女 1-男 2-其他
  age?: string;
  avatar?: string;
  tags?: string[];
  appearance?: string;
  personality?: string;
  background?: string;
  ability?: string;
  /** 人物关系 JSON：存储层当不透明数据透传，无结构约定 */
  relationships?: unknown;
  sortNo?: number;
}

export interface CharacterGroup {
  id: number;
  bookId: string;
  title: string;
  sortNo: number;
  preset?: number;
}

/** 角色关系画布的连线分类（决定线色；语义细节写在 label 里） */
export type CharacterRelationType = 'family' | 'love' | 'friend' | 'enemy' | 'other';

/** 角色关系画布的一条连线：无向边，两角色之间至多一条 */
export interface CharacterRelation {
  id: number;
  bookId: string;
  fromId: number;
  toId: number;
  relationType: CharacterRelationType;
  /** 自由文字标签（师徒、宿敌、青梅竹马……），可空 */
  label: string;
}

export interface Inspiration {
  id: number;
  bookId?: string;
  authorId?: string;
  content: string;
  tag?: string;
  sortNo?: number;
  isPinned?: number;
  createTime?: string;
  updateTime?: string;
}

export interface InspirationInsights {
  hotTags: string[];
  dailySuggestion: string;
}

export interface OutlineNode {
  id: number;
  bookId: string;
  parentId: string;
  nodeType: number; // 0-folder 1-outline
  title: string;
  content?: string;
  sortNo: number;
  children?: OutlineNode[];
}
