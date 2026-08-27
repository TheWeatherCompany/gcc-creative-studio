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
import {MatCardModule} from '@angular/material/card';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatSnackBar} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {ActivatedRoute} from '@angular/router';
import {RouterTestingModule} from '@angular/router/testing';
import {setAppInjector} from '../app-injector';
import {NotificationService} from '../common/services/notification.service';
import {AuthService} from './../common/services/auth.service';
import {LoginComponent} from './login.component';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let authService: jasmine.SpyObj<AuthService>;
  let notificationService: jasmine.SpyObj<NotificationService>;
  let queryParams: Record<string, string>;

  beforeEach(async () => {
    queryParams = {};
    authService = jasmine.createSpyObj('AuthService', ['login']);
    authService.login.and.returnValue(Promise.resolve());
    notificationService = jasmine.createSpyObj('NotificationService', ['show']);

    await TestBed.configureTestingModule({
      imports: [
        RouterTestingModule,
        MatCardModule,
        MatFormFieldModule,
        MatInputModule,
        NoopAnimationsModule,
      ],
      declarations: [LoginComponent],
      providers: [
        {provide: AuthService, useValue: authService},
        {
          provide: MatSnackBar,
          useValue: jasmine.createSpyObj('MatSnackBar', ['open']),
        },
        {provide: NotificationService, useValue: notificationService},
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: {get: (key: string) => queryParams[key] ?? null},
            },
          },
        },
      ],
    }).compileComponents();

    setAppInjector(TestBed.inject(Injector));

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  describe('login', () => {
    it('shows the loader and hands off to Okta', () => {
      component.login();

      expect(component.loader).toBeTrue();
      expect(authService.login).toHaveBeenCalledWith('/');
    });

    it('forwards the returnUrl query param so deep links survive', () => {
      queryParams = {returnUrl: '/workflows/edit/7'};

      component.login();

      expect(authService.login).toHaveBeenCalledWith('/workflows/edit/7');
    });

    it('rejects an absolute returnUrl and falls back home', () => {
      queryParams = {returnUrl: 'https://evil.example.com/phish'};

      component.login();

      expect(authService.login).toHaveBeenCalledWith('/');
    });

    it('rejects a protocol-relative returnUrl', () => {
      queryParams = {returnUrl: '//evil.example.com'};

      component.login();

      expect(authService.login).toHaveBeenCalledWith('/');
    });

    it('rejects a backslash-smuggled returnUrl', () => {
      queryParams = {returnUrl: '/\\evil.example.com'};

      component.login();

      expect(authService.login).toHaveBeenCalledWith('/');
    });

    it('keeps the query string on an in-app returnUrl', () => {
      queryParams = {returnUrl: '/galleries?page=2'};

      component.login();

      expect(authService.login).toHaveBeenCalledWith('/galleries?page=2');
    });

    it('drops the loader and reports a failure to reach Okta', async () => {
      spyOn(console, 'error');
      authService.login.and.returnValue(
        Promise.reject(new Error('Okta is unreachable')),
      );

      component.login();
      await Promise.resolve().then(() => {});
      await Promise.resolve();

      expect(component.loader).toBeFalse();
      expect(notificationService.show).toHaveBeenCalledWith(
        'Okta is unreachable',
        'error',
        'cross-in-circle-white',
        undefined,
        5000,
      );
    });
  });
});
