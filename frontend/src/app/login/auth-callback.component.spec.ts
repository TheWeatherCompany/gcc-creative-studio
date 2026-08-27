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

import {Injector} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {of, throwError} from 'rxjs';
import {setAppInjector} from '../app-injector';
import {NotificationService} from '../common/services/notification.service';
import {AuthService} from '../common/services/auth.service';
import {AuthCallbackComponent} from './auth-callback.component';

describe('AuthCallbackComponent', () => {
  let component: AuthCallbackComponent;
  let fixture: ComponentFixture<AuthCallbackComponent>;
  let authService: jasmine.SpyObj<AuthService>;
  let router: jasmine.SpyObj<Router>;
  let notificationService: jasmine.SpyObj<NotificationService>;

  beforeEach(async () => {
    authService = jasmine.createSpyObj('AuthService', ['handleCallback']);
    router = jasmine.createSpyObj('Router', ['navigate', 'navigateByUrl']);
    router.navigate.and.returnValue(Promise.resolve(true));
    router.navigateByUrl.and.returnValue(Promise.resolve(true));
    notificationService = jasmine.createSpyObj('NotificationService', ['show']);

    await TestBed.configureTestingModule({
      imports: [MatProgressSpinnerModule],
      declarations: [AuthCallbackComponent],
      providers: [
        {provide: AuthService, useValue: authService},
        {provide: Router, useValue: router},
        {
          provide: MatSnackBar,
          useValue: jasmine.createSpyObj('MatSnackBar', ['open']),
        },
        {provide: NotificationService, useValue: notificationService},
      ],
    }).compileComponents();

    setAppInjector(TestBed.inject(Injector));

    fixture = TestBed.createComponent(AuthCallbackComponent);
    component = fixture.componentInstance;
  });

  it('navigates to the originally requested URL once the exchange succeeds', () => {
    authService.handleCallback.and.returnValue(of('/workflows'));

    fixture.detectChanges();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/workflows');
  });

  it('returns to the login page and surfaces the reason on failure', () => {
    spyOn(console, 'error');
    authService.handleCallback.and.returnValue(
      throwError(() => new Error('No Creative Studio group assigned.')),
    );

    fixture.detectChanges();

    expect(component.statusMessage).toBe('Sign-in failed.');
    expect(notificationService.show).toHaveBeenCalledWith(
      'No Creative Studio group assigned.',
      'error',
      'cross-in-circle-white',
      undefined,
      5000,
    );
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('shows progress while the exchange is in flight', () => {
    authService.handleCallback.and.returnValue(of('/'));

    fixture.detectChanges();

    expect(component.statusMessage).toBe('Signing you in...');
  });
});
