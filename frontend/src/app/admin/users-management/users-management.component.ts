/**
 * Copyright 2025 Google LLC
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

import {
  Component,
  OnInit,
  OnDestroy,
  ViewChild,
  Inject,
  PLATFORM_ID,
} from '@angular/core';
import {MatTableDataSource} from '@angular/material/table';
import {MatPaginator, PageEvent} from '@angular/material/paginator';
import {MatSort} from '@angular/material/sort';
import {Subject, firstValueFrom} from 'rxjs';
import {debounceTime, distinctUntilChanged, takeUntil} from 'rxjs/operators';
import {isPlatformBrowser} from '@angular/common';
import {UserService, PaginatedResponse} from './user.service';
import {MatDialog} from '@angular/material/dialog';
import {UserFormComponent} from './user-form.component';
import {UserModel, UserRolesEnum} from '../../common/models/user.model';
import {environment} from '../../../environments/environment';

@Component({
  selector: 'app-users-management',
  templateUrl: './users-management.component.html',
  styleUrls: ['./users-management.component.scss'],
  standalone: false,
})
export class UsersManagementComponent implements OnInit, OnDestroy {
  displayedColumns: string[] = [
    'picture',
    'name',
    'email',
    'roles',
    'createdAt',
    'updatedAt',
    'actions',
  ];
  dataSource: MatTableDataSource<UserModel> =
    new MatTableDataSource<UserModel>();
  isLoading = true;
  errorLoadingUsers: string | null = null;
  lastResponse: PaginatedResponse | undefined;

  // --- Pagination State ---
  totalUsers = 0;
  limit = 10;
  currentPageIndex = 0;
  readonly defaultAvatarUrl = environment.defaultAvatarUrl;

  // --- Filtering & Destroy State ---
  private filterSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  currentFilter = '';
  includeDeleted = false; // Added

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  @ViewChild(MatSort) sort!: MatSort;

  constructor(
    private userService: UserService,
    public dialog: MatDialog,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {}

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      void this.fetchPage(0);
    }

    // Debounce filter input to avoid excessive Firestore reads
    this.filterSubject
      .pipe(debounceTime(500), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(filterValue => {
        this.currentFilter = filterValue;
        this.resetPaginationAndFetch();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  handlePageEvent(event: PageEvent) {
    // If page size changes, we must reset everything.
    if (this.limit !== event.pageSize) {
      this.limit = event.pageSize;
      this.resetPaginationAndFetch();
      return;
    }
    void this.fetchPage(event.pageIndex);
  }

  async fetchPage(targetPageIndex: number) {
    this.isLoading = true;
    const offset = targetPageIndex * this.limit;

    try {
      const finalResponse = await firstValueFrom(
        this.userService.getUsers(
          this.limit,
          this.currentFilter,
          offset,
          this.includeDeleted, // Pass here
        ),
        {defaultValue: {data: [], count: 0} as any},
      );

      this.dataSource.data = finalResponse.data;
      this.totalUsers = finalResponse.count;
      this.currentPageIndex = targetPageIndex;
    } catch (err) {
      this.errorLoadingUsers = 'Failed to load users.';
      console.error(err);
    } finally {
      this.isLoading = false;
    }
  }

  applyFilter(event: Event): void {
    const filterValue = (event.target as HTMLInputElement).value;
    this.filterSubject.next(filterValue.trim().toLowerCase());
  }

  private resetPaginationAndFetch() {
    this.currentPageIndex = 0;
    if (this.paginator) {
      this.paginator.pageIndex = 0;
    }
    void this.fetchPage(0);
  }

  onIncludeDeletedChange(checked: boolean) {
    this.includeDeleted = checked;
    this.resetPaginationAndFetch();
  }

  /** Opens the read-only user detail dialog. Roles come from Okta. */
  openUserForm(user: UserModel): void {
    this.dialog.open(UserFormComponent, {
      width: '450px',
      data: {user},
    });
  }

  public getRoleChipClass(role: string): string {
    const roleLower = role.toLowerCase();

    // Using a switch statement makes it easy to add more roles later
    switch (roleLower) {
      case UserRolesEnum.ADMIN.toLowerCase():
        return '!bg-amber-500/20 !text-amber-300';
      case UserRolesEnum.USER.toLowerCase():
        return '!bg-blue-500/20 !text-blue-300';
      case UserRolesEnum.CREATOR.toLowerCase():
        return '!bg-purple-500/20 !text-purple-300';
      case UserRolesEnum.WORKFLOWS.toLowerCase():
        return '!bg-green-500/20 !text-green-300';
      default:
        // It's good practice to have a default style
        return '!bg-gray-500/20 !text-gray-300';
    }
  }
}
