/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/package-info.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by LCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import {
  PackageInfo,
  PackageInfoChangeType,
  PackageInfoContent,
  PackageInfoDependencies,
  PackageInfoDependency,
  PackageInfoDescription,
  PackageInfoHeader,
  PackageInfoName,
  PackageInfoVersion,
} from "@/components/ai-elements/package-info";

const Example = () => (
  <div className="flex flex-col gap-4">
    <PackageInfo changeType="major" currentVersion="18.2.0" name="react" newVersion="19.0.0">
      <PackageInfoHeader>
        <PackageInfoName />
        <PackageInfoChangeType />
      </PackageInfoHeader>
      <PackageInfoVersion />
      <PackageInfoDescription>
        A JavaScript library for building user interfaces.
      </PackageInfoDescription>
      <PackageInfoContent>
        <PackageInfoDependencies>
          <PackageInfoDependency name="react-dom" version="^19.0.0" />
          <PackageInfoDependency name="scheduler" version="^0.24.0" />
        </PackageInfoDependencies>
      </PackageInfoContent>
    </PackageInfo>

    <PackageInfo changeType="added" name="lodash">
      <PackageInfoHeader>
        <PackageInfoName />
        <PackageInfoChangeType />
      </PackageInfoHeader>
      <PackageInfoVersion />
    </PackageInfo>

    <PackageInfo changeType="removed" currentVersion="2.29.4" name="moment" />
  </div>
);

export default Example;
