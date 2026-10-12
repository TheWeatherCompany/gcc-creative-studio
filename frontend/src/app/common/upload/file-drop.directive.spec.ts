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

import {Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {FileDropDirective} from './file-drop.directive';

@Component({
  template: `
    <div
      class="zone"
      appFileDrop
      [appFileDropAccept]="accept"
      [appFileDropMultiple]="multiple"
      [appFileDropDisabled]="disabled"
      (filesDropped)="dropped = $event"
      (filesRejected)="rejected = $event"
    >
      <span class="child">child</span>
    </div>
  `,
  imports: [FileDropDirective],
})
class HostComponent {
  accept = 'image/*';
  multiple = false;
  disabled = false;
  dropped: File[] | null = null;
  rejected: File[] | null = null;
}

@Component({
  template: `
    <div
      class="zone"
      appFileDrop
      (filesDropped)="dropped = $event"
      (uriDropped)="uri = $event"
    ></div>
  `,
  imports: [FileDropDirective],
})
class UriHostComponent {
  dropped: File[] | null = null;
  uri: string | null = null;
}

function transferOf(...files: File[]): DataTransfer {
  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  return dt;
}

function fire(target: Element, type: string, dt: DataTransfer): DragEvent {
  const event = new DragEvent(type, {
    dataTransfer: dt,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/**
 * A synthetic DataTransfer ignores dropEffect writes in Chrome, so cursor
 * feedback is observed through a stand-in attached to the event.
 */
function dragoverWithEffect(target: Element): {
  event: DragEvent;
  transfer: {types: string[]; dropEffect: string};
} {
  const event = new DragEvent('dragover', {bubbles: true, cancelable: true});
  const transfer = {types: ['Files'], dropEffect: 'move'};
  Object.defineProperty(event, 'dataTransfer', {value: transfer});
  target.dispatchEvent(event);
  return {event, transfer};
}

describe('FileDropDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let zone: HTMLElement;
  let child: HTMLElement;
  const png = new File(['x'], 'a.png', {type: 'image/png'});
  const jpg = new File(['x'], 'b.jpg', {type: 'image/jpeg'});
  const mp4 = new File(['x'], 'c.mp4', {type: 'video/mp4'});

  beforeEach(() => {
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    zone = fixture.nativeElement.querySelector('.zone');
    child = fixture.nativeElement.querySelector('.child');
  });

  it('stays highlighted while the pointer moves over a child', () => {
    const dt = transferOf(png);
    fire(zone, 'dragenter', dt);
    fire(child, 'dragenter', dt);
    fire(zone, 'dragleave', dt);
    fixture.detectChanges();
    expect(zone.classList).toContain('file-drop-active');

    fire(child, 'dragleave', dt);
    fixture.detectChanges();
    expect(zone.classList).not.toContain('file-drop-active');
  });

  it('recovers from a stray dragleave', () => {
    const dt = transferOf(png);
    fire(zone, 'dragleave', dt);
    fire(zone, 'dragenter', dt);
    fire(zone, 'dragleave', dt);
    fixture.detectChanges();
    expect(zone.classList).not.toContain('file-drop-active');
  });

  it('clears the highlight once the file is dropped', () => {
    const dt = transferOf(png);
    fire(zone, 'dragenter', dt);
    fire(child, 'dragenter', dt);
    fire(child, 'drop', dt);
    fixture.detectChanges();
    expect(zone.classList).not.toContain('file-drop-active');

    fire(zone, 'dragenter', dt);
    fire(zone, 'dragleave', dt);
    fixture.detectChanges();
    expect(zone.classList).not.toContain('file-drop-active');
  });

  it('does not highlight while disabled', () => {
    host.disabled = true;
    fixture.detectChanges();
    fire(zone, 'dragenter', transferOf(png));
    fixture.detectChanges();
    expect(zone.classList).not.toContain('file-drop-active');
  });

  it('takes the drag over the zone so the browser fires a drop, even when disabled', () => {
    expect(fire(zone, 'dragover', transferOf(png)).defaultPrevented).toBeTrue();

    host.disabled = true;
    fixture.detectChanges();
    expect(fire(zone, 'dragover', transferOf(png)).defaultPrevented).toBeTrue();
  });

  it('shows a copy cursor over an enabled zone and none over a disabled one', () => {
    expect(dragoverWithEffect(zone).transfer.dropEffect).toBe('copy');

    host.disabled = true;
    fixture.detectChanges();
    expect(dragoverWithEffect(zone).transfer.dropEffect).toBe('none');
  });

  it('emits only the first accepted file unless multiple', () => {
    fire(zone, 'drop', transferOf(png, jpg));
    expect(host.dropped).toEqual([png]);
  });

  it('emits every accepted file when multiple', () => {
    host.multiple = true;
    fixture.detectChanges();
    fire(zone, 'drop', transferOf(png, jpg));
    expect(host.dropped).toEqual([png, jpg]);
  });

  it('reports files that fail the accept filter', () => {
    fire(zone, 'drop', transferOf(mp4));
    expect(host.dropped).toBeNull();
    expect(host.rejected).toEqual([mp4]);
  });

  it('reports the rejects and still emits the accepted files of a mixed drop', () => {
    host.multiple = true;
    fixture.detectChanges();
    fire(zone, 'drop', transferOf(png, mp4));
    expect(host.dropped).toEqual([png]);
    expect(host.rejected).toEqual([mp4]);
  });

  it('drops nothing while disabled, but still stops the browser opening the file', () => {
    host.disabled = true;
    fixture.detectChanges();
    const event = fire(zone, 'drop', transferOf(png));
    expect(host.dropped).toBeNull();
    expect(event.defaultPrevented).toBeTrue();
  });

  it('keeps a drop from reaching an enclosing drop target', () => {
    let reachedParent = false;
    fixture.nativeElement.addEventListener('drop', () => {
      reachedParent = true;
    });
    fire(zone, 'drop', transferOf(png));
    expect(reachedParent).toBeFalse();
  });

  it('ignores in-app drags so folder moves keep working', () => {
    const dt = new DataTransfer();
    dt.setData('application/json', '{"mediaItemIds":[1]}');
    expect(fire(zone, 'dragenter', dt).defaultPrevented).toBeFalse();
    expect(fire(zone, 'dragover', dt).defaultPrevented).toBeFalse();
    const event = fire(zone, 'drop', dt);
    expect(event.defaultPrevented).toBeFalse();
    expect(host.dropped).toBeNull();
    fixture.detectChanges();
    expect(zone.classList).not.toContain('file-drop-active');
  });
});

describe('FileDropDirective URL drops', () => {
  function uriTransfer(): DataTransfer {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://example.com/cat.png');
    return dt;
  }

  it('claims a URL-only drag when a host listens for uriDropped', () => {
    const fixture = TestBed.createComponent(UriHostComponent);
    fixture.detectChanges();
    const zone = fixture.nativeElement.querySelector('.zone');
    const event = fire(zone, 'drop', uriTransfer());
    expect(event.defaultPrevented).toBeTrue();
    expect(fixture.componentInstance.uri).toBe('https://example.com/cat.png');
  });

  it('leaves a URL-only drag alone when nothing listens for uriDropped', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const zone = fixture.nativeElement.querySelector('.zone');
    const event = fire(zone, 'drop', uriTransfer());
    expect(event.defaultPrevented).toBeFalse();
  });
});

@Component({
  template: `
    <div
      class="outer"
      appFileDrop
      [appFileDropDisabled]="outerDisabled"
      (filesDropped)="outerDropped = $event"
      (uriDropped)="outerUri = $event"
    >
      <div
        class="inner"
        appFileDrop
        [appFileDropIgnore]="innerIgnored"
        (filesDropped)="innerDropped = $event"
      ></div>
    </div>
  `,
  imports: [FileDropDirective],
})
class NestedHostComponent {
  outerDisabled = false;
  innerIgnored = false;
  outerDropped: File[] | null = null;
  innerDropped: File[] | null = null;
  outerUri: string | null = null;
}

describe('FileDropDirective nested zones', () => {
  let fixture: ComponentFixture<NestedHostComponent>;
  let host: NestedHostComponent;
  let outer: HTMLElement;
  let inner: HTMLElement;
  const png = new File(['x'], 'a.png', {type: 'image/png'});

  beforeEach(() => {
    fixture = TestBed.createComponent(NestedHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    outer = fixture.nativeElement.querySelector('.outer');
    inner = fixture.nativeElement.querySelector('.inner');
  });

  it('lets the inner zone alone highlight for a drag over it', () => {
    fire(inner, 'dragenter', transferOf(png));
    fixture.detectChanges();
    expect(inner.classList).toContain('file-drop-active');
    expect(outer.classList).not.toContain('file-drop-active');
  });

  it('keeps the copy cursor over an inner zone inside a disabled one', () => {
    host.outerDisabled = true;
    fixture.detectChanges();
    expect(dragoverWithEffect(inner).transfer.dropEffect).toBe('copy');
  });

  it('gives an ignored inner zone drag to the enclosing zone', () => {
    host.innerIgnored = true;
    fixture.detectChanges();
    fire(inner, 'drop', transferOf(png));
    expect(host.innerDropped).toBeNull();
    expect(host.outerDropped).toEqual([png]);
  });

  it('passes a URL drag the inner zone does not take on to the outer one', () => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://example.com/cat.png');
    fire(inner, 'drop', dt);
    expect(host.outerUri).toBe('https://example.com/cat.png');
  });
});
