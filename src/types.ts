export interface Part {
  id?: number; main_category: string; sub_category: string; category: string;
  name: string; model: string; cost: number; specs: string; projects: string;
  remark: string; created_at?: string; updated_at?: string;
}
export interface Project {
  id?: number; code: string; name: string; project_type: string;
  tier: string; status: string; screen_size: string; resolution: string;
  refresh_rate: string; panel_type: string; platform_fee_rate: number;
  profit_rate: number; image?: string; created_at?: string;
}
export interface ProjectBOM {
  id?: number; project_id: number; part_id: number; module_name: string;
  quantity: number; remark: string; part_name?: string; part_model?: string;
  part_cost?: number; main_category?: string; sub_category?: string; category?: string;
}
export interface Module { id?: number; project_id: number; name: string; description: string; created_at?: string; }
export interface ModuleItem {
  id?: number; module_id: number; part_id?: number; part_name: string;
  part_model: string; main_category: string; sub_category: string;
  cost: number; quantity: number; remark: string;
}
export interface ProductFeature { id?: number; name: string; weight: number; }
export interface ProductScore { id?: number; ref_type: string; ref_id: number; feature_id: number; score: number; }
export interface PriceHistory { id?: number; part_id: number; old_cost: number; new_cost: number; changed_at?: string; }
export interface Competitor {
  id?: number; brand: string; model: string; tier: string;
  market_price: number; bom_cost: number; platform_fee_rate: number; remark: string; created_at?: string;
}
export interface CompetitorBOM {
  id?: number; competitor_id: number; part_id?: number; part_name: string;
  part_model: string; estimated_cost: number; quantity: number; is_mapped: number;
  main_category?: string; category?: string;
}
export interface CompetitorPart {
  id?: number; main_category: string; sub_category: string; category: string;
  name: string; model: string; cost: number; specs: string; remark: string;
}
export interface CostReview {
  id?: number; project_id: number; stage: string; reviewed_cost: number;
  reviewer: string; reviewed_at?: string; remark: string;
}
export interface Measure {
  id?: number; project_id: number; main_category: string; measure: string;
  status: string; due_date: string; owner: string; remark: string;
}
export interface DashboardStats {
  total_parts: number; total_projects: number; active_projects: number;
  total_competitors: number; avg_bom_cost: number;
  category_distribution: { category: string; count: number }[];
  recent_parts: Part[];
}
export interface PartSupplier {
  id?: number; part_id: number; supplier_name: string; unit_price: number;
  moq: number; lead_time: string; priority: number; remark: string;
  price?: number; share_ratio?: number; is_active?: number;
}
export interface ProjectSupplier {
  id?: number;
  supplier_name: string;
  share_ratio?: number;
  is_active?: number;
  project_id?: number;
  quoted_price?: number;
}
