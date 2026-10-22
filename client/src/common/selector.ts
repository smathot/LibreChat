import React from 'react';
import { TStartupConfig } from 'librechat-data-provider';

export interface Endpoint {
  value: string;
  label: string;
  /** Deployment-defined subtitle from `interface.endpointDescription`, rendered
   *  under the label in the model selector menu. */
  description?: string;
  hasModels: boolean;
  models?: Array<{ name: string; isGlobal?: boolean }>;
  icon: React.ReactNode;
  /** Deployment-defined subtitles from `interface.modelDescription`, keyed by
   *  model id; rendered under the model name in the selector menu. */
  modelDescriptions?: Record<string, string>;
  agentNames?: Record<string, string>;
  assistantNames?: Record<string, string>;
  modelIcons?: Record<string, string | undefined>;
  showMarketplace?: boolean;
  searchAliases?: string[];
}

export interface SelectedValues {
  endpoint: string | null;
  model: string | null;
  modelSpec: string | null;
}

export interface ModelSelectorProps {
  startupConfig: TStartupConfig | undefined;
}
