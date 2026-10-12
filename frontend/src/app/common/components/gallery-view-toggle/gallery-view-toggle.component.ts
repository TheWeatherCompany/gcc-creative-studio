/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Component, Input} from '@angular/core';

export type GalleryView = 'grid' | 'feed';

/**
 * Two-segment switch between the gallery grid and the generations feed.
 * The other view's segment is a plain router link, so middle-click and
 * keyboard work as for any link. The segment matching `active` carries
 * aria-current="page" and is not a link: the gallery also renders at
 * /folders/:folderId, where a link to /gallery would drop the user out of
 * the folder they are already viewing as a grid.
 */
@Component({
  selector: 'gallery-view-toggle',
  templateUrl: './gallery-view-toggle.component.html',
  styleUrls: ['./gallery-view-toggle.component.scss'],
  standalone: false,
})
export class GalleryViewToggleComponent {
  @Input({required: true}) active!: GalleryView;
  // Launch flair for the feed. Flip the default to false (or delete the
  // badge markup) once the feed is established.
  @Input() showNewBadge = true;
}
