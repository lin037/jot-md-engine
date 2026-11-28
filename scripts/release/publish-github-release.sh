#!/usr/bin/env bash
set -euo pipefail

tag="v$1"
filename="jot-md-editor-$1.tgz"
archive="release/$filename"
ref="refs/tags/$tag"
tag_object=$(gh api "repos/$GH_REPO/git/matching-refs/tags/$tag" \
  --jq ".[] | select(.ref == \"$ref\") | .object")

if [[ -z "$tag_object" ]]; then
  gh api "repos/$GH_REPO/git/refs" -f ref="$ref" -f sha="$GITHUB_SHA" --silent
else
  while [[ $(jq -r .type <<< "$tag_object") == tag ]]; do
    tag_object=$(gh api "repos/$GH_REPO/git/tags/$(jq -r .sha <<< "$tag_object")" --jq .object)
  done
  if [[ $(jq -r .sha <<< "$tag_object") != "$GITHUB_SHA" ]]; then
    echo "$tag already points to a different commit" >&2
    exit 1
  fi
fi

if release=$(gh release view "$tag" --json isDraft,assets); then
  if jq -e --arg name "$filename" '.assets | any(.name == $name)' <<< "$release" > /dev/null; then
    existing=$(mktemp -d)
    trap 'rm -rf "$existing"' EXIT
    gh release download "$tag" --pattern "$filename" --dir "$existing"
    cmp "$archive" "$existing/$filename"
  else
    gh release upload "$tag" "$archive"
  fi
  if [[ $(jq -r .isDraft <<< "$release") == true ]]; then
    gh release edit "$tag" --draft=false
  fi
else
  gh release create "$tag" "$archive" --verify-tag --generate-notes
fi
